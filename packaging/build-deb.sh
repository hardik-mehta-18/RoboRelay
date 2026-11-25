#!/usr/bin/env bash
set -eo pipefail
project=$(cd "$(dirname "$0")/.." && pwd)
source /etc/os-release
if [[ "$ID" != ubuntu || "$VERSION_ID" != 26.04 ]]; then
  echo 'Build this package on Ubuntu 26.04 with ROS 2 Lyrical.' >&2
  exit 1
fi
if ! command -v node >/dev/null && [[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
  source "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
  nvm use 24
fi
source /opt/ros/lyrical/setup.bash
node_binary=$(command -v node)
arch=$(dpkg --print-architecture)
version=$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1])).version" "$project/package.json")-1
work=$(mktemp -d /tmp/ros-agent-deb.XXXXXX)
trap 'rm -rf -- "$work"' EXIT
root="$work/package"
app="$root/opt/roborelay"
mkdir -p "$app/runtime" "$root/DEBIAN" "$root/usr/bin" \
  "$root/usr/lib/systemd/system" "$root/etc/roborelay" \
  "$root/usr/share/doc/roborelay" "$project/dist"
cp "$project/package.json" "$project/package-lock.json" "$app/"
cp -r "$project/src" "$project/public" "$app/"
cp "$node_binary" "$app/runtime/node"
node_license="$(dirname "$(dirname "$node_binary")")/LICENSE"
if [[ -f "$node_license" ]]; then
  cp "$node_license" "$root/usr/share/doc/roborelay/Node-LICENSE"
else
  echo "Node distribution LICENSE not found at $node_license" >&2
  exit 1
fi
cd "$app"
npm ci --omit=dev --no-audit --no-fund
# Verify that the native ROS binding loads before producing an installer.
./runtime/node --input-type=module -e 'import rcl from "rclnodejs"; await rcl.init(); rcl.shutdown();'
cp "$project/packaging/roborelay" "$root/usr/bin/roborelay"
cp "$project/packaging/roborelay.service" "$root/usr/lib/systemd/system/"
cp "$project/packaging/agent.env" "$root/etc/roborelay/agent.env"
cp "$project/packaging/README.md" "$root/usr/share/doc/roborelay/README.md"
cp "$project/packaging/"{preinst,postinst,prerm,postrm} "$root/DEBIAN/"
chmod 755 "$root/usr/bin/roborelay" "$app/runtime/node" "$root/DEBIAN/"{preinst,postinst,prerm,postrm}
chmod -R go-w "$app"
chmod 644 "$root/usr/lib/systemd/system/roborelay.service" \
  "$root/etc/roborelay/agent.env" "$root/usr/share/doc/roborelay/"*
printf '/etc/roborelay/agent.env\n' > "$root/DEBIAN/conffiles"
cat > "$root/DEBIAN/control" <<EOF
Package: roborelay
Version: $version
Architecture: $arch
Maintainer: RoboRelay maintainers <maintainers@localhost>
Section: net
Priority: optional
Depends: bash, adduser, systemd, ca-certificates, libc6 (>= 2.43), libstdc++6, libgcc-s1, libatomic1, ros-lyrical-ros-base
Description: ROS 2 topic discovery and durable telemetry bridge
 Local dashboard with webhook and MQTT delivery. Includes a private Node.js
 runtime. Built for Ubuntu 26.04 and ROS 2 Lyrical.
EOF
dpkg-deb --root-owner-group -Zgzip --build "$root" \
  "$project/dist/roborelay_${version}_${arch}.deb"
