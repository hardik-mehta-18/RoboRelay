#!/usr/bin/env bash
set -eo pipefail
cd "$(dirname "$0")"
if ! command -v node >/dev/null && [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  source "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
  nvm use 24
fi
source "${ROS_SETUP:-/opt/ros/lyrical/setup.bash}"
if [ "$1" = "--install" ]; then
  npm ci
else
  exec npm start
fi
