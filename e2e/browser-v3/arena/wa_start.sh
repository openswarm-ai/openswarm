#!/bin/bash
# Start WebArena's self-hosted sites and post-configure them per environment_docker/README.
# Idempotent: docker start if the container exists, docker run if not. Hostname is localhost.
set -u
D=/Applications/Docker.app/Contents/Resources/bin/docker
export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock
H=localhost

up() { # name image port_map extra_runs...
  local name=$1 image=$2 ports=$3
  $D start "$name" 2>/dev/null || $D run --name "$name" $ports -d "$image"
}

up shopping shopping_final_0712 "-p 7770:80"
up shopping_admin shopping_admin_final_0719 "-p 7780:80"
up forum postmill-populated-exposed-withimg "-p 9999:80"
up gitlab gitlab-populated-final-port8023 "-p 8023:8023"

echo "waiting 90s for services to boot"; sleep 90

$D exec shopping /var/www/magento2/bin/magento setup:store-config:set --base-url="http://$H:7770"
$D exec shopping mysql -u magentouser -pMyPassword magentodb -e "UPDATE core_config_data SET value=\"http://$H:7770/\" WHERE path = \"web/secure/base_url\";"
$D exec shopping /var/www/magento2/bin/magento cache:flush
$D exec shopping_admin /var/www/magento2/bin/magento setup:store-config:set --base-url="http://$H:7780"
$D exec shopping_admin mysql -u magentouser -pMyPassword magentodb -e "UPDATE core_config_data SET value=\"http://$H:7780/\" WHERE path = \"web/secure/base_url\";"
$D exec shopping_admin php /var/www/magento2/bin/magento config:set admin/security/password_is_forced 0
$D exec shopping_admin php /var/www/magento2/bin/magento config:set admin/security/password_lifetime 0
$D exec shopping_admin /var/www/magento2/bin/magento cache:flush
$D exec gitlab sed -i "s|^external_url.*|external_url 'http://$H:8023'|" /etc/gitlab/gitlab.rb
$D exec gitlab gitlab-ctl reconfigure

for p in 7770 7780 9999 8023; do
  echo -n "port $p: "; curl -s -o /dev/null -w "%{http_code}\n" -m 10 "http://$H:$p" || echo fail
done
echo "WEBARENA SITES UP"
