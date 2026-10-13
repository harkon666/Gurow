#!/usr/bin/env bash
# Prepares a fresh Ubuntu host for Gurow: Docker with Compose, and a firewall that leaves
# only SSH, HTTP and HTTPS open. Safe to run again.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq
sudo apt-get install -y -qq docker.io docker-compose-v2 rsync ufw >/dev/null
sudo systemctl enable --now docker >/dev/null
sudo usermod -aG docker "$USER"
sudo ufw allow OpenSSH >/dev/null
sudo ufw allow 80/tcp >/dev/null
sudo ufw allow 443/tcp >/dev/null
sudo ufw --force enable >/dev/null
sudo mkdir -p /opt/gurow
sudo chown "$USER": /opt/gurow
docker --version
docker compose version
