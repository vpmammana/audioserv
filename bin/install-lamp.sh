#!/usr/bin/env bash
set -euo pipefail
if [[ $EUID -ne 0 ]]; then
    echo 'Execute: sudo bash bin/install-lamp.sh'
    exit 1
fi
APP_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
APP_OWNER="$(stat -c %U "$APP_ROOT")"
if [[ ! "$APP_ROOT" =~ ^/[a-zA-Z0-9_./-]+$ ]]; then
    echo 'Use um caminho sem espaços ou caracteres especiais.'
    exit 1
fi
command -v php ffmpeg ffprobe mysql apache2ctl >/dev/null
php -r 'exit(extension_loaded("pdo_mysql") && extension_loaded("mbstring") && extension_loaded("pcntl") ? 0 : 1);'
apache2ctl -M 2>/dev/null | grep -q php_module
install -d -m 2770 -o "$APP_OWNER" -g www-data "$APP_ROOT/var" "$APP_ROOT/var/uploads" "$APP_ROOT/var/work" "$APP_ROOT/var/logs"
chgrp www-data "$APP_ROOT/config"
chmod 750 "$APP_ROOT/config"
php "$APP_ROOT/bin/install-database.php"
chown "$APP_OWNER":www-data "$APP_ROOT/config/local.php"
chmod 640 "$APP_ROOT/config/local.php"
if [[ -f /etc/apache2/conf-available/audiocontinuo.conf ]] && ! grep -q 'Managed by Áudio Contínuo' /etc/apache2/conf-available/audiocontinuo.conf; then
    echo 'Já existe configuração Apache audiocontinuo não gerenciada por este projeto. Revise antes de instalar.'
    exit 1
fi
cat > /etc/apache2/conf-available/audiocontinuo.conf <<CONF
# Managed by Áudio Contínuo: $APP_ROOT
RedirectMatch 301 ^/audiocontinuo$ /audiocontinuo/
Alias /audiocontinuo/ $APP_ROOT/public/
<Directory $APP_ROOT/public>
    Options -Indexes -FollowSymLinks
    AllowOverride None
    Require all granted
    DirectoryIndex index.php
    LimitRequestBody 1048576
    php_admin_value upload_max_filesize 1M
    php_admin_value post_max_size 1M
    php_admin_value max_execution_time 60
    php_admin_value memory_limit 256M
    php_admin_flag display_errors Off
    php_admin_flag log_errors On
    php_admin_flag zlib.output_compression Off
    SetEnv no-gzip 1
</Directory>
CONF
if [[ -f /etc/systemd/system/audiocontinuo-worker.service ]] && ! grep -q 'Managed by Áudio Contínuo' /etc/systemd/system/audiocontinuo-worker.service; then
    echo 'Já existe serviço audiocontinuo-worker não gerenciado por este projeto. Revise antes de instalar.'
    exit 1
fi
cat > /etc/systemd/system/audiocontinuo-worker.service <<UNIT
# Managed by Áudio Contínuo: $APP_ROOT
[Unit]
Description=Áudio Contínuo Whisper GPU queue worker
After=mysql.service network.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=$APP_OWNER
Group=www-data
WorkingDirectory=$APP_ROOT
ExecStart=/usr/bin/php $APP_ROOT/bin/worker.php
Restart=always
RestartSec=10
KillMode=control-group
TimeoutStopSec=35
UMask=0007
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$APP_ROOT/var
MemoryMax=6G
TasksMax=128

[Install]
WantedBy=multi-user.target
UNIT
a2enconf audiocontinuo >/dev/null
if ! apache2ctl configtest; then
    a2disconf audiocontinuo >/dev/null
    echo 'A configuração não foi aplicada. Corrija o erro acima e execute novamente.'
    exit 1
fi
systemctl reload apache2
systemctl daemon-reload
systemctl enable --now audiocontinuo-worker
echo 'Áudio Contínuo instalado em /audiocontinuo/. Consulte: systemctl status audiocontinuo-worker'
