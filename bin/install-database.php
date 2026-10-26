#!/usr/bin/env php
<?php
declare(strict_types=1);
function installation_error(string $message): never { fwrite(STDERR, $message . "\n"); exit(1); }
if (PHP_SAPI !== 'cli' || posix_geteuid() !== 0) installation_error('Execute pelo instalador com sudo.');
$root = dirname(__DIR__);
$target = $root . '/config/local.php';
$admin = new PDO('mysql:unix_socket=/var/run/mysqld/mysqld.sock;charset=utf8mb4', 'root', '', [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
if (!is_file($target)) {
    if ($admin->query("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = 'audioserv'")->fetchColumn()) {
        installation_error('O banco audioserv já existe. Configure config/local.php antes de continuar; nenhum dado foi alterado.');
    }
    if ($admin->query("SELECT COUNT(*) FROM mysql.user WHERE User = 'audioserv' AND Host = 'localhost'")->fetchColumn()) {
        installation_error('O usuário MySQL audioserv já existe. Configure config/local.php com suas credenciais antes de continuar.');
    }
    $c = require $root . '/config/example.php';
    $c['db']['password'] = bin2hex(random_bytes(24));
    $c['secret'] = bin2hex(random_bytes(32));
    // Save first so a retry can recover an interrupted provisioning without rotating credentials.
    umask(0027);
    file_put_contents($target, "<?php\nreturn " . var_export($c, true) . ";\n", LOCK_EX);
    chmod($target, 0640);
}
$c = require $target;
if ($c['db']['user'] !== 'audioserv' || !str_contains($c['db']['dsn'], 'dbname=audioserv;')) {
    installation_error('Este instalador atende ao banco audioserv. Para um banco personalizado, aplique database/schema.sql manualmente.');
}
$admin->exec('CREATE DATABASE IF NOT EXISTS audioserv CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
$password = $admin->quote($c['db']['password']);
$admin->exec("CREATE USER IF NOT EXISTS 'audioserv'@'localhost' IDENTIFIED BY $password");
$admin->exec("GRANT SELECT, INSERT, UPDATE, DELETE ON audioserv.* TO 'audioserv'@'localhost'");
$admin->exec('USE audioserv');
$admin->exec(file_get_contents($root . '/database/schema.sql'));
// Verify the application login before modifying Apache or enabling the worker.
new PDO($c['db']['dsn'], $c['db']['user'], $c['db']['password'], [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
echo "Banco audioserv configurado; credenciais salvas apenas em config/local.php.\n";
