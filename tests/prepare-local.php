#!/usr/bin/env php
<?php
// Creates an isolated configuration, never config/local.php or the host database.
declare(strict_types=1);
$root = dirname(__DIR__);
$qa = $root . '/var/qa';
foreach ([$qa, "$qa/uploads", "$qa/work", "$qa/logs", "$qa/apache"] as $path) if (!is_dir($path)) mkdir($path, 0700, true);
$c = require $root . '/config/example.php';
$c['secret'] = bin2hex(random_bytes(32));
$c['base_path'] = '/';
$c['cookie_secure'] = false;
$c['storage'] = $qa;
$c['db'] = ['dsn' => 'mysql:host=127.0.0.1;port=33079;dbname=audioserv_test;charset=utf8mb4', 'user' => 'audioserv_test', 'password' => bin2hex(random_bytes(24))];
if (!is_file("$qa/config.php")) {
    umask(0077);
    file_put_contents("$qa/config.php", "<?php\nreturn " . var_export($c, true) . ";\n");
    file_put_contents("$qa/mysql.env", "MYSQL_ROOT_PASSWORD=" . bin2hex(random_bytes(24)) . "\nMYSQL_DATABASE=audioserv_test\nMYSQL_USER=audioserv_test\nMYSQL_PASSWORD=" . $c['db']['password'] . "\n");
}
$modules = ['mpm_prefork','authz_core','authz_host','dir','mime','env'];
$conf = "ServerRoot /etc/apache2\nServerName localhost\nListen 127.0.0.1:8096\nPidFile $qa/apache/httpd.pid\nDefaultRuntimeDir $qa/apache\nErrorLog $qa/logs/apache-error.log\nLogLevel warn\n";
foreach ($modules as $m) $conf .= "LoadModule {$m}_module /usr/lib/apache2/modules/mod_$m.so\n";
$conf .= "LoadModule php_module /usr/lib/apache2/modules/libphp8.3.so\nDocumentRoot $root/public\nDirectoryIndex index.php\nTypesConfig /etc/mime.types\nStartServers 2\nMinSpareServers 2\nMaxSpareServers 5\nMaxRequestWorkers 20\n";
$conf .= "SetEnv AUDIOSERV_CONFIG $qa/config.php\n<FilesMatch \\\.php$>\nSetHandler application/x-httpd-php\n</FilesMatch>\n";
$conf .= "<Directory $root/public>\nRequire all granted\nAllowOverride None\nOptions -Indexes\n</Directory>\n";
$conf .= "php_admin_value upload_max_filesize 100M\nphp_admin_value post_max_size 102M\nphp_admin_value memory_limit 256M\nphp_admin_flag display_errors Off\nphp_admin_flag zlib.output_compression Off\n";
file_put_contents("$qa/apache/httpd.conf", $conf);
echo "Configuração de teste pronta em var/qa (Apache :8096, MySQL :33079).\n";
