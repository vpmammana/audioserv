<?php
declare(strict_types=1);
require dirname(__DIR__, 2) . '/app/bootstrap.php';
api(function (): void {
    require_method('POST');
    $d = device();
    require_csrf($d);
    $c = config();
    if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > $c['max_upload_bytes'] + 65536) {
        throw new HttpError(413, 'O áudio ultrapassa o limite de 100 MB.');
    }
    $file = $_FILES['audio'] ?? null;
    if (!$file || is_array($file['error']) || $file['error'] !== UPLOAD_ERR_OK) {
        throw new HttpError(400, 'O envio não foi concluído. Verifique o arquivo e tente novamente.');
    }
    if (!is_uploaded_file($file['tmp_name']) || $file['size'] < 128 || $file['size'] > $c['max_upload_bytes']) {
        throw new HttpError(413, 'Envie um áudio entre 128 bytes e 100 MB.');
    }
    $request = (string) ($_POST['request_id'] ?? '');
    if (!preg_match('/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iD', $request)) {
        throw new HttpError(422, 'Identificador de envio inválido.');
    }
    $model = query('SELECT id, slug FROM whisper_models WHERE slug = ? AND enabled = 1', [(string) ($_POST['model'] ?? 'small')])->fetch();
    if (!$model || !is_readable(model_path($model['slug']))) throw new HttpError(422, 'Este modelo não está instalado no servidor.');
    $language = (string) ($_POST['language'] ?? 'pt');
    if (!in_array($language, ['auto', 'pt', 'en', 'es', 'fr', 'de', 'it'], true)) throw new HttpError(422, 'Idioma não suportado.');
    $mime = (new finfo(FILEINFO_MIME_TYPE))->file($file['tmp_name']);
    $types = ['audio/webm','video/webm','video/x-matroska','audio/x-matroska','audio/ogg','application/ogg',
        'audio/wav','audio/x-wav','audio/wave','audio/vnd.wave','audio/mpeg','audio/mp4','video/mp4',
        'audio/x-m4a','audio/flac','audio/x-flac','audio/aac','audio/x-hx-aac-adts'];
    if (!in_array($mime, $types, true)) throw new HttpError(415, 'Formato não reconhecido. Use WebM, Ogg, WAV, MP3, M4A ou FLAC.');
    $stored = null;
    try {
        db()->beginTransaction();
        lock_device($d['id']);
        $existing = query('SELECT j.id FROM audio_files a JOIN transcription_jobs j ON j.audio_file_id = a.id WHERE a.device_id = ? AND a.request_id = ?', [$d['id'], $request])->fetchColumn();
        if ($existing) {
            db()->commit();
            json_response(['job' => get_job((int) $existing, $d['id']), 'duplicate' => true], 200);
        }
        $pending = (int) query("SELECT COUNT(*) FROM transcription_jobs j JOIN audio_files a ON a.id = j.audio_file_id
            WHERE a.device_id = ? AND j.status IN ('queued','normalizing','transcribing')", [$d['id']])->fetchColumn();
        $hour = (int) query('SELECT COUNT(*) FROM audio_files WHERE device_id = ? AND created_at > DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 HOUR)', [$d['id']])->fetchColumn();
        $bytes = (int) query('SELECT COALESCE(SUM(byte_size), 0) FROM audio_files WHERE device_id = ?', [$d['id']])->fetchColumn();
        if ($pending >= $c['max_pending_per_device'] || $hour >= $c['max_uploads_per_hour']) {
            header('Retry-After: 60');
            throw new HttpError(429, 'Você tem muitos envios recentes. Aguarde a fila avançar.');
        }
        if ($bytes + $file['size'] > $c['max_storage_per_device']) throw new HttpError(413, 'O limite de armazenamento deste dispositivo foi atingido.');
        if (disk_free_space($c['storage']) < $file['size'] + 512 * 1024 * 1024) throw new HttpError(503, 'O servidor está sem espaço para novos áudios.');
        $key = bin2hex(random_bytes(24)) . '.audio';
        $stored = $c['storage'] . '/uploads/' . $key;
        $hash = hash_file('sha256', $file['tmp_name']);
        if (!move_uploaded_file($file['tmp_name'], $stored)) throw new RuntimeException('Falha ao armazenar upload.');
        chmod($stored, 0660);
        $name = mb_substr(preg_replace('/[\x00-\x1F\x7F]/u', '', basename($file['name'])) ?: 'Gravação', 0, 180);
        query('INSERT INTO audio_files (device_id, request_id, storage_key, original_name, mime_type, byte_size, content_sha256)
            VALUES (?, ?, ?, ?, ?, ?, ?)', [$d['id'], strtolower($request), $key, $name, $mime, $file['size'], $hash]);
        $audio = (int) db()->lastInsertId();
        query('INSERT INTO transcription_jobs (audio_file_id, model_id, language) VALUES (?, ?, ?)', [$audio, $model['id'], $language]);
        $id = (int) db()->lastInsertId();
        emit_event($id, 'queued', "Áudio $id recebido. Aguardando na fila.");
        db()->commit();
        $stored = null;
        json_response(['job' => get_job($id, $d['id'])], 202);
    } catch (Throwable $e) {
        if (db()->inTransaction()) db()->rollBack();
        if ($stored && is_file($stored)) unlink($stored);
        throw $e;
    }
});
