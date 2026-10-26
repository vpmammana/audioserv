<?php
declare(strict_types=1);

function config(): array
{
    static $config;
    if ($config === null) {
        $file = getenv('AUDIOSERV_CONFIG') ?: dirname(__DIR__) . '/config/local.php';
        if (!is_file($file)) {
            throw new RuntimeException('AudioServ ainda não foi configurado. Execute bin/install-lamp.sh.');
        }
        $config = array_replace(require dirname(__DIR__) . '/config/example.php', require $file);
        if (strlen($config['secret']) < 32) {
            throw new RuntimeException('Configure uma chave secreta de pelo menos 32 caracteres.');
        }
    }
    return $config;
}

function db(): PDO
{
    static $pdo;
    if (!$pdo) {
        $c = config()['db'];
        $pdo = new PDO($c['dsn'], $c['user'], $c['password'], [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]);
        $pdo->exec("SET time_zone = '+00:00'");
    }
    return $pdo;
}

function query(string $sql, array $args = []): PDOStatement
{
    $stmt = db()->prepare($sql);
    $stmt->execute($args);
    return $stmt;
}

function json_response(array $data, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
    exit;
}

final class HttpError extends RuntimeException
{
    public function __construct(public int $status, string $message)
    {
        parent::__construct($message);
    }
}

function api(callable $callback): never
{
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: same-origin');
    try {
        $callback();
    } catch (HttpError $e) {
        if (db()->inTransaction()) db()->rollBack();
        json_response(['error' => $e->getMessage()], $e->status);
    } catch (Throwable $e) {
        error_log('AudioServ: ' . $e->getMessage());
        json_response(['error' => 'Serviço indisponível. Tente novamente em instantes.'], 503);
    }
    exit;
}

function require_method(string $method): void
{
    if ($_SERVER['REQUEST_METHOD'] !== $method) {
        header('Allow: ' . $method);
        throw new HttpError(405, 'Método não permitido.');
    }
}

function device(bool $create = false): array
{
    $token = $_COOKIE['audioserv_device'] ?? '';
    $valid = is_string($token) && preg_match('/^[a-f0-9]{64}$/D', $token);
    $hash = $valid ? hash_hmac('sha256', $token, config()['secret']) : '';
    $row = $hash ? query('SELECT * FROM client_devices WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP(3)', [$hash])->fetch() : false;
    if (!$row) {
        if (!$create) throw new HttpError(401, 'Sua sessão expirou. Recarregue a página.');
        $token = bin2hex(random_bytes(32));
        $hash = hash_hmac('sha256', $token, config()['secret']);
        query('INSERT INTO client_devices (token_hash, expires_at) VALUES (?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 365 DAY))', [$hash]);
        $row = ['id' => (int) db()->lastInsertId(), 'user_id' => null, 'token_hash' => $hash];
    }
    if ($create) {
        $secure = config()['cookie_secure'] || (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ||
            (config()['trust_proxy_https'] && ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
        $expires = isset($row['expires_at']) ? (new DateTimeImmutable($row['expires_at'], new DateTimeZone('UTC')))->getTimestamp() : time() + 365 * 86400;
        setcookie('audioserv_device', $token, [
            'expires' => $expires, 'path' => config()['base_path'],
            'secure' => $secure, 'httponly' => true, 'samesite' => 'Lax',
        ]);
    }
    $row['id'] = (int) $row['id'];
    $row['csrf'] = hash_hmac('sha256', 'csrf:' . $token, config()['secret']);
    return $row;
}

function require_csrf(array $device): void
{
    if (!hash_equals($device['csrf'], (string) ($_SERVER['HTTP_X_CSRF_TOKEN'] ?? ''))) {
        throw new HttpError(403, 'Recarregue a página antes de enviar o áudio.');
    }
}

function lock_device(int $id): void
{
    // Every writer locks the device before inserting an event. This makes cursor
    // commit order deterministic for a device, including concurrent uploads.
    query('SELECT id FROM client_devices WHERE id = ? FOR UPDATE', [$id])->fetch();
}

function emit_event(int $job, string $status, string $message): int
{
    query('INSERT INTO job_events (job_id, status, message) VALUES (?, ?, ?)', [$job, $status, $message]);
    return (int) db()->lastInsertId();
}

function models(): array
{
    return array_map(function (array $m): array {
        $m['available'] = is_readable(model_path($m['slug']));
        $m['id'] = (int) $m['id'];
        return $m;
    }, query('SELECT id, slug, label, description FROM whisper_models WHERE enabled = 1 ORDER BY sort_order')->fetchAll());
}

function model_path(string $slug): string
{
    if (!in_array($slug, ['tiny','base','small','medium','large-v3-turbo','large-v3'], true)) {
        throw new InvalidArgumentException('Modelo desconhecido.');
    }
    return config()['models_dir'] . '/ggml-' . $slug . '.bin';
}

function job_select(): string
{
    return 'SELECT j.id, j.status, j.progress, j.language, j.attempts, j.created_at, j.started_at, j.finished_at,
        j.error_code, j.error_message, a.original_name, a.byte_size, a.duration_ms, a.request_id,
        m.slug AS model, m.label AS model_label, t.text, t.detected_language, t.processing_ms
        FROM transcription_jobs j JOIN audio_files a ON a.id = j.audio_file_id
        JOIN whisper_models m ON m.id = j.model_id LEFT JOIN transcriptions t ON t.job_id = j.id ';
}

function format_job(array $job): array
{
    foreach (['id', 'progress', 'attempts', 'byte_size', 'duration_ms', 'processing_ms'] as $key) {
        $job[$key] = $job[$key] === null ? null : (int) $job[$key];
    }
    foreach (['created_at', 'started_at', 'finished_at'] as $key) {
        if ($job[$key]) $job[$key] = str_replace(' ', 'T', $job[$key]) . 'Z';
    }
    return $job;
}

function get_job(int $id, int $device): array
{
    $row = query(job_select() . ' WHERE j.id = ? AND a.device_id = ?', [$id, $device])->fetch();
    if (!$row) throw new HttpError(404, 'Áudio não encontrado.');
    return format_job($row);
}

function worker_health(): array
{
    $row = query("SELECT status, gpu_name, TIMESTAMPDIFF(SECOND, last_seen_at, UTC_TIMESTAMP(3)) AS age
        FROM worker_heartbeats ORDER BY last_seen_at DESC LIMIT 1")->fetch();
    return ['online' => $row && (int) $row['age'] < 30 && in_array($row['status'], ['ready', 'busy'], true),
        'gpu' => $row['gpu_name'] ?? null];
}

function events_after(int $device, int $cursor): array
{
    $rows = query('SELECT e.id, e.job_id, e.status, e.message FROM job_events e
        JOIN transcription_jobs j ON j.id = e.job_id JOIN audio_files a ON a.id = j.audio_file_id
        WHERE a.device_id = ? AND e.id > ? ORDER BY e.id LIMIT 100', [$device, $cursor])->fetchAll();
    return array_map(function (array $e) use ($device): array {
        return ['id' => (int) $e['id'], 'status' => $e['status'], 'message' => $e['message'],
            'job' => get_job((int) $e['job_id'], $device)];
    }, $rows);
}
