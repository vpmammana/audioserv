<?php
declare(strict_types=1);
require dirname(__DIR__, 2) . '/app/bootstrap.php';
api(function (): void {
    if (!in_array($_SERVER['REQUEST_METHOD'], ['GET', 'HEAD'], true)) throw new HttpError(405, 'Método não permitido.');
    $d = device();
    $row = query('SELECT a.storage_key, a.mime_type, a.byte_size FROM audio_files a JOIN transcription_jobs j ON j.audio_file_id = a.id
        WHERE j.id = ? AND a.device_id = ?', [(int) ($_GET['id'] ?? 0), $d['id']])->fetch();
    if (!$row) throw new HttpError(404, 'Áudio não encontrado.');
    $path = config()['storage'] . '/uploads/' . $row['storage_key'];
    if (!is_file($path)) throw new HttpError(404, 'Arquivo não encontrado.');
    $size = filesize($path);
    $start = 0;
    $end = $size - 1;
    header('Accept-Ranges: bytes');
    if (isset($_SERVER['HTTP_RANGE'])) {
        if (!preg_match('/^bytes=(\d*)-(\d*)$/D', $_SERVER['HTTP_RANGE'], $m) || ($m[1] === '' && $m[2] === '')) {
            header("Content-Range: bytes */$size");
            throw new HttpError(416, 'Intervalo inválido.');
        }
        if ($m[1] === '') $start = max(0, $size - (int) $m[2]);
        else { $start = (int) $m[1]; if ($m[2] !== '') $end = min($end, (int) $m[2]); }
        if ($start > $end || $start >= $size) {
            header("Content-Range: bytes */$size");
            throw new HttpError(416, 'Intervalo inválido.');
        }
        http_response_code(206);
        header("Content-Range: bytes $start-$end/$size");
    }
    header('Content-Type: ' . $row['mime_type']);
    header('Content-Disposition: inline; filename="audio-' . (int) $_GET['id'] . '"');
    header('Content-Length: ' . ($end - $start + 1));
    if ($_SERVER['REQUEST_METHOD'] === 'HEAD') return;
    $handle = fopen($path, 'rb');
    fseek($handle, $start);
    $remaining = $end - $start + 1;
    while ($remaining > 0 && !feof($handle) && !connection_aborted()) {
        $chunk = fread($handle, min(65536, $remaining));
        echo $chunk;
        $remaining -= strlen($chunk);
    }
    fclose($handle);
});
