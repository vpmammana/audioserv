<?php
declare(strict_types=1);

return [
    'db' => [
        'dsn' => 'mysql:unix_socket=/var/run/mysqld/mysqld.sock;dbname=audiocontinuo;charset=utf8mb4',
        'user' => 'audiocontinuo',
        'password' => 'GENERATED_BY_INSTALLER',
    ],
    'secret' => 'GENERATED_BY_INSTALLER',
    'base_path' => '/audiocontinuo/',
    // Public deployment is HTTPS, including when TLS terminates at a proxy.
    'cookie_secure' => true,
    // Enable only behind a trusted HTTPS reverse proxy which overwrites this header.
    'trust_proxy_https' => false,
    'storage' => dirname(__DIR__) . '/var',
    'whisper_binary' => '/home/victor/whisper.cpp/build/bin/whisper-cli',
    'models_dir' => '/home/victor/whisper.cpp/models',
    'require_gpu' => true,
    'threads' => 6,
    'max_upload_bytes' => 15 * 32000 + 44,
    'max_duration_seconds' => 15,
    'chunk_seconds' => 10,
    'queue_bytes_per_device' => 4 * 1024 * 1024,
    'queue_bytes_global' => 32 * 1024 * 1024,
    'max_pending_per_device' => 160,
    'max_uploads_per_hour' => 1200,
    'max_storage_per_device' => 2 * 1024 * 1024 * 1024,
    'job_timeout_seconds' => 1800,
    'lease_seconds' => 90,
    'stream_seconds' => 25,
];
