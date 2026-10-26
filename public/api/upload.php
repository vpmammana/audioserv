<?php
declare(strict_types=1);
require dirname(__DIR__, 2) . '/app/bootstrap.php';
api(function (): void {
    require_method('POST');
    $d = device();
    require_csrf($d);
    $c = config();
    if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > $c['max_upload_bytes'] + 65536) {
        throw new HttpError(413, 'O trecho ultrapassa o tamanho permitido.');
    }
    $file = $_FILES['audio'] ?? null;
    if (!$file || is_array($file['error']) || $file['error'] !== UPLOAD_ERR_OK || !is_uploaded_file($file['tmp_name'])) {
        throw new HttpError(400, 'O envio não foi concluído. Tente novamente.');
    }
    $size = (int) $file['size'];
    if ($size < 3244 || $size > $c['max_upload_bytes']) throw new HttpError(413, 'O trecho deve conter entre 0,1 e 15 segundos.');
    $request = strtolower((string) ($_POST['request_id'] ?? ''));
    $recording = strtolower((string) ($_POST['recording_id'] ?? ''));
    $uuid = '/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/D';
    if (!preg_match($uuid, $request) || !preg_match($uuid, $recording)) throw new HttpError(422, 'Identificador de gravação inválido.');
    $chunk = filter_var($_POST['chunk_number'] ?? '', FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 1000000]]);
    if (!$chunk) throw new HttpError(422, 'Número de trecho inválido.');
    $model = query('SELECT id, slug FROM whisper_models WHERE slug = ? AND enabled = 1', [(string) ($_POST['model'] ?? 'small')])->fetch();
    if (!$model || !is_readable(model_path($model['slug']))) throw new HttpError(422, 'Este modelo não está instalado.');
    $language = (string) ($_POST['language'] ?? 'pt');
    if (!in_array($language, ['auto', 'pt', 'en', 'es', 'fr', 'de', 'it'], true)) throw new HttpError(422, 'Idioma não suportado.');
    // The capture worklet emits canonical PCM WAV. Enforce the format so bytes
    // represent audio time consistently, before a file consumes queue capacity.
    $header = file_get_contents($file['tmp_name'], false, null, 0, 44);
    $wav = strlen($header) === 44 ? unpack('a4riff/Vsize/a4wave/a4fmt/Vfmt_size/vencoding/vchannels/Vrate/Vbyte_rate/valign/vbits/a4data/Vdata_size', $header) : false;
    if (!$wav || $wav['riff'] !== 'RIFF' || $wav['wave'] !== 'WAVE' || $wav['fmt'] !== 'fmt ' ||
        $wav['fmt_size'] !== 16 || $wav['encoding'] !== 1 || $wav['channels'] !== 1 || $wav['rate'] !== 16000 ||
        $wav['byte_rate'] !== 32000 || $wav['align'] !== 2 || $wav['bits'] !== 16 || $wav['data'] !== 'data' ||
        $wav['data_size'] !== $size - 44 || $wav['size'] !== $size - 8 || $wav['data_size'] % 2 !== 0) {
        throw new HttpError(415, 'Formato de trecho inválido. Grave novamente pelo aplicativo.');
    }
    $duration = (int) round(($size - 44) / 32);
    $stored = null;
    try {
        db()->beginTransaction();
        query('SELECT id FROM queue_admission WHERE id = 1 FOR UPDATE')->fetch();
        lock_device($d['id']);
        $existing = query('SELECT j.id FROM audio_files a JOIN transcription_jobs j ON j.audio_file_id = a.id
            WHERE a.device_id = ? AND (a.request_id = ? OR (a.recording_id = ? AND a.chunk_number = ?))',
            [$d['id'], $request, $recording, $chunk])->fetchColumn();
        if ($existing) {
            db()->commit();
            json_response(['job' => get_job((int) $existing, $d['id']), 'duplicate' => true]);
        }
        if ($chunk > 1 && !query('SELECT id FROM audio_files WHERE device_id = ? AND recording_id = ? AND chunk_number = ?', [$d['id'], $recording, $chunk - 1])->fetchColumn()) {
            throw new HttpError(409, 'Reenvie primeiro o trecho anterior desta gravação.', 'chunk_order');
        }
        $usage = query("SELECT COALESCE(SUM(a.byte_size),0) AS bytes, COUNT(*) AS count FROM transcription_jobs j
            JOIN audio_files a ON a.id = j.audio_file_id WHERE a.device_id = ? AND j.status IN ('queued','normalizing','transcribing')", [$d['id']])->fetch();
        $global = (int) query("SELECT COALESCE(SUM(a.byte_size),0) FROM transcription_jobs j JOIN audio_files a ON a.id = j.audio_file_id
            WHERE j.status IN ('queued','normalizing','transcribing')")->fetchColumn();
        if ((int) $usage['bytes'] + $size > $c['queue_bytes_per_device'] || $global + $size > $c['queue_bytes_global'] || (int) $usage['count'] >= $c['max_pending_per_device']) {
            header('Retry-After: 5');
            throw new HttpError(429, 'Limite de tempo alcançado. Aguarde a fila diminuir.', 'queue_limit');
        }
        $hour = (int) query('SELECT COUNT(*) FROM audio_files WHERE device_id = ? AND created_at > DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 HOUR)', [$d['id']])->fetchColumn();
        if ($hour >= $c['max_uploads_per_hour']) throw new HttpError(429, 'Limite de envios por hora alcançado. Aguarde para continuar.', 'rate_limit');
        $bytes = (int) query('SELECT COALESCE(SUM(byte_size), 0) FROM audio_files WHERE device_id = ?', [$d['id']])->fetchColumn();
        if ($bytes + $size > $c['max_storage_per_device']) throw new HttpError(413, 'O limite de armazenamento deste dispositivo foi atingido.', 'storage_limit');
        if (disk_free_space($c['storage']) < $size + 512 * 1024 * 1024) throw new HttpError(503, 'O servidor está sem espaço para novos áudios.');
        $key = bin2hex(random_bytes(24)) . '.audio';
        $stored = $c['storage'] . '/uploads/' . $key;
        $hash = hash_file('sha256', $file['tmp_name']);
        if (!move_uploaded_file($file['tmp_name'], $stored)) throw new RuntimeException('Falha ao armazenar trecho.');
        chmod($stored, 0660);
        $name = 'Trecho ' . $chunk . ' · ' . substr($recording, 0, 8) . '.wav';
        query('INSERT INTO audio_files (device_id, request_id, recording_id, chunk_number, storage_key, original_name, mime_type, byte_size, content_sha256, duration_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [$d['id'], $request, $recording, $chunk, $key, $name, 'audio/wav', $size, $hash, $duration]);
        $audio = (int) db()->lastInsertId();
        query('INSERT INTO transcription_jobs (audio_file_id, model_id, language) VALUES (?, ?, ?)', [$audio, $model['id'], $language]);
        $id = (int) db()->lastInsertId();
        emit_event($id, 'queued', "Trecho $chunk recebido como áudio $id. Aguardando na fila.");
        db()->commit();
        $stored = null;
        json_response(['job' => get_job($id, $d['id'])], 202);
    } catch (Throwable $e) {
        if (db()->inTransaction()) db()->rollBack();
        if ($stored && is_file($stored)) unlink($stored);
        throw $e;
    }
});
