#!/usr/bin/env bash
# One-time preparation of a fresh Ubuntu 24.04 LTS server for the gateway. Run as root:
#   sudo bash deploy/server-setup.sh --admin-key "ssh-ed25519 AAAA... you@laptop" [--admin-ip 203.0.113.7]
# It is meant to be read before it is run. It: updates the system, installs Docker from Docker's own repository,
# creates the user `deploy` (log in as that user from now on), opens only SSH/80/443 in the firewall, turns password
# logins off (only when your key is installed, so you cannot lock yourself out), keeps the clock exact, rotates Docker
# logs, turns on automatic security updates, and installs the backup / health / restore-test timers.
# NOT tested on a real server yet (only syntax-checked); run it on a new, empty machine first.
set -euo pipefail

key=""; admin_ip=""
while [ $# -gt 0 ]; do
  case "$1" in
    --admin-key) key=${2:?}; shift 2 ;;
    --admin-ip) admin_ip=${2:?}; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 2; }
[ -n "$key" ] || { echo "give your public key with --admin-key" >&2; exit 2; }
. /etc/os-release
[ "$ID" = ubuntu ] && [ "${VERSION_ID%%.*}" -ge 24 ] || { echo "this script is written for Ubuntu 24.04" >&2; exit 2; }
here=$(cd "$(dirname "$0")/.." && pwd)

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get -y upgrade
apt-get -y install ca-certificates curl gnupg ufw fail2ban unattended-upgrades chrony rclone

# Docker from Docker's repository
if ! command -v docker > /dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
cat > /etc/docker/daemon.json <<'JSON'
{ "log-driver": "local", "log-opts": { "max-size": "10m", "max-file": "3" } }
JSON
systemctl enable --now docker
systemctl restart docker   # applies the log settings (containers created later; existing ones keep theirs)

# the working user. Membership of the docker group is root-equivalent: it belongs to people you trust.
id deploy > /dev/null 2>&1 || adduser --disabled-password --gecos "" deploy
usermod -aG docker deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
grep -qxF "$key" /home/deploy/.ssh/authorized_keys 2>/dev/null || echo "$key" >> /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys; chown deploy:deploy /home/deploy/.ssh/authorized_keys

# firewall: SSH (from one address if you give it), HTTP for certificates, HTTPS
ufw --force reset > /dev/null
ufw default deny incoming
ufw default allow outgoing
if [ -n "$admin_ip" ]; then ufw allow from "$admin_ip" to any port 22 proto tcp; else ufw limit 22/tcp; fi
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
# Docker publishes ports through iptables and can bypass ufw; the compose file publishes only the proxy's 80 and 443.

# SSH: keys only (the key was installed above)
cat > /etc/ssh/sshd_config.d/10-pts2.conf <<'CONF'
PasswordAuthentication no
PermitRootLogin no
KbdInteractiveAuthentication no
CONF
sshd -t && systemctl reload ssh

systemctl enable --now fail2ban chrony
timedatectl set-timezone UTC
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
CONF
echo "vm.swappiness=10" > /etc/sysctl.d/90-pts2.conf; sysctl --system > /dev/null

# the project lives in /opt/pts2-gateway, owned by deploy
if [ "$here" != /opt/pts2-gateway ]; then
  mkdir -p /opt/pts2-gateway
  cp -a "$here"/. /opt/pts2-gateway/
fi
chown -R deploy:deploy /opt/pts2-gateway
install -d -m 700 -o deploy -g deploy /var/backups/pts2 /var/lib/pts2-ops
[ -f /opt/pts2-gateway/.env ] || cp /opt/pts2-gateway/.env.example /opt/pts2-gateway/.env
chown deploy:deploy /opt/pts2-gateway/.env; chmod 600 /opt/pts2-gateway/.env

# timers run as deploy
for u in pts2-backup pts2-health pts2-restore-test; do
  for ext in service timer; do
    sed 's#^\[Service\]#[Service]\nUser=deploy#' "/opt/pts2-gateway/deploy/systemd/$u.$ext" > "/etc/systemd/system/$u.$ext"
  done
done
systemctl daemon-reload
echo
echo "Done. Next, as the user deploy (ssh deploy@this-server):"
echo "  cd /opt/pts2-gateway && nano .env      # POSTGRES_PASSWORD, DOMAIN, ACME_EMAIL, alert and backup settings"
echo "  docker compose -f docker-compose.yml -f deploy/compose.prod.yaml up -d --build"
echo "  sudo systemctl enable --now pts2-backup.timer pts2-health.timer pts2-restore-test.timer"
echo "Point the DNS name in DOMAIN at this server first, or the certificate cannot be issued."
