-- MySQL 8.0+, UTC, InnoDB. This migration never drops existing data.
CREATE TABLE IF NOT EXISTS users (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    public_id CHAR(36) CHARACTER SET ascii NOT NULL UNIQUE,
    email VARCHAR(254) NULL UNIQUE,
    password_hash VARCHAR(255) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS client_devices (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NULL,
    token_hash CHAR(64) CHARACTER SET ascii NOT NULL UNIQUE,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    expires_at DATETIME(3) NOT NULL,
    revoked_at DATETIME(3) NULL,
    CONSTRAINT device_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS whisper_models (
    id SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    slug VARCHAR(40) CHARACTER SET ascii NOT NULL UNIQUE,
    label VARCHAR(80) NOT NULL,
    description VARCHAR(255) NOT NULL,
    sort_order SMALLINT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO whisper_models (slug, label, description, sort_order) VALUES
('tiny', 'Tiny', 'Muito rápido · para falas curtas e claras', 10),
('base', 'Base', 'Rápido · transcrições simples', 20),
('small', 'Small', 'Equilibrado · velocidade e precisão', 30),
('medium', 'Medium', 'Mais preciso · processamento mais demorado', 40),
('large-v3-turbo', 'Large v3 Turbo', 'Modelo grande otimizado para velocidade', 50),
('large-v3', 'Large v3', 'Maior precisão · mais tempo de processamento', 60);

CREATE TABLE IF NOT EXISTS audio_files (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    device_id BIGINT UNSIGNED NOT NULL,
    request_id CHAR(36) CHARACTER SET ascii NOT NULL,
    storage_key VARCHAR(80) CHARACTER SET ascii NOT NULL UNIQUE,
    original_name VARCHAR(180) NOT NULL,
    mime_type VARCHAR(80) CHARACTER SET ascii NOT NULL,
    byte_size BIGINT UNSIGNED NOT NULL,
    content_sha256 CHAR(64) CHARACTER SET ascii NOT NULL,
    duration_ms INT UNSIGNED NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY device_request (device_id, request_id),
    KEY device_created (device_id, created_at),
    CONSTRAINT audio_device_fk FOREIGN KEY (device_id) REFERENCES client_devices(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS transcription_jobs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    audio_file_id BIGINT UNSIGNED NOT NULL UNIQUE,
    model_id SMALLINT UNSIGNED NOT NULL,
    language VARCHAR(8) CHARACTER SET ascii NOT NULL DEFAULT 'pt',
    status ENUM('queued','normalizing','transcribing','completed','failed') NOT NULL DEFAULT 'queued',
    progress TINYINT UNSIGNED NOT NULL DEFAULT 0,
    attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
    max_attempts TINYINT UNSIGNED NOT NULL DEFAULT 3,
    lease_token CHAR(32) CHARACTER SET ascii NULL,
    lease_until DATETIME(3) NULL,
    available_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    started_at DATETIME(3) NULL,
    finished_at DATETIME(3) NULL,
    error_code VARCHAR(40) CHARACTER SET ascii NULL,
    error_message VARCHAR(255) NULL,
    KEY queue_ready (status, available_at, id),
    KEY abandoned (status, lease_until),
    CONSTRAINT job_audio_fk FOREIGN KEY (audio_file_id) REFERENCES audio_files(id),
    CONSTRAINT job_model_fk FOREIGN KEY (model_id) REFERENCES whisper_models(id)
) ENGINE=InnoDB AUTO_INCREMENT=10001 DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS transcriptions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    job_id BIGINT UNSIGNED NOT NULL UNIQUE,
    detected_language VARCHAR(16) CHARACTER SET ascii NULL,
    text LONGTEXT NOT NULL,
    processing_ms INT UNSIGNED NOT NULL,
    engine VARCHAR(80) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    CONSTRAINT transcript_job_fk FOREIGN KEY (job_id) REFERENCES transcription_jobs(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS transcription_segments (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    transcription_id BIGINT UNSIGNED NOT NULL,
    sequence_number INT UNSIGNED NOT NULL,
    start_ms INT UNSIGNED NOT NULL,
    end_ms INT UNSIGNED NOT NULL,
    text TEXT NOT NULL,
    UNIQUE KEY transcript_sequence (transcription_id, sequence_number),
    CONSTRAINT segment_transcript_fk FOREIGN KEY (transcription_id) REFERENCES transcriptions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS job_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    job_id BIGINT UNSIGNED NOT NULL,
    status VARCHAR(20) CHARACTER SET ascii NOT NULL,
    message VARCHAR(255) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    KEY job_cursor (job_id, id),
    CONSTRAINT event_job_fk FOREIGN KEY (job_id) REFERENCES transcription_jobs(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS worker_heartbeats (
    worker_id VARCHAR(80) CHARACTER SET ascii NOT NULL PRIMARY KEY,
    last_seen_at DATETIME(3) NOT NULL,
    status VARCHAR(30) CHARACTER SET ascii NOT NULL,
    gpu_name VARCHAR(120) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
