# Linux installer

This package targets Ubuntu 26.04, ROS 2 Lyrical, and the CPU architecture used
to build it. The first build is amd64 (x64). It bundles Node.js and installed
dependencies; the target machine needs neither npm nor a separate Node install.
ROS 2 is a system dependency. Configure its apt repository before installing
on a machine that does not already have ROS 2 Lyrical.

## Build in Ubuntu WSL

Requires Node.js 24 with npm on the build machine, ROS 2 Lyrical, dpkg-deb,
and internet access for the locked dependencies. Native compilation on platforms
without a prebuilt rclnodejs binary also requires a C++ toolchain.

```bash
cd roborelay
bash packaging/build-deb.sh
```

Builds in a temporary Linux directory and writes the installer to `dist/`.
No existing `.env`, settings, or queued telemetry are included in the package.


## Install in Ubuntu WSL or on a matching robot computer

Stop any development bridge already using port 8780 first. Then:

```bash
sudo apt install ./dist/roborelay_0.1.6-1_amd64.deb
sudo systemctl status roborelay --no-pager
```

The service starts automatically and is enabled for subsequent Linux boots.
In WSL, the distro and systemd must be running. Open http://localhost:8780,
select topics, set a webhook or MQTT broker, and save. No old development
settings are imported. Start Gazebo separately in the same WSL distro.

```bash
sudo journalctl -u roborelay -f
sudo systemctl restart roborelay
sudo systemctl stop roborelay
sudo systemctl disable roborelay
```

Edit `/etc/roborelay/agent.env` with sudo for the ROS domain, credentials,
port, or an optional ROS overlay. It contains shell assignments and must remain
root owned. Restart after editing. Install any custom ROS message packages
and use a build that includes their generated rclnodejs bindings.

The application and private Node runtime live in `/opt/roborelay`.
Settings and outbox files live in `/var/lib/roborelay/data`, owned by the
dedicated service account. Upgrades retain them and the environment file.
The service has its own ROS log directory under `/var/lib/roborelay/.ros`.

```bash
sudo apt remove roborelay
```

Removal stops the service. Queued data and its service account are preserved,
including on purge, to avoid deleting pending robot readings. Back up the
state directory before moving the installation to another device.
