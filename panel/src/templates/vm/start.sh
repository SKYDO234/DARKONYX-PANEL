#!/bin/bash
set -euo pipefail

# Ensure container working directory is fully accessible
chmod 777 /home/container 2>/dev/null || true



validate_int() {
    local name="$1" value="$2" min="$3" max="${4:-}"
    # cap at 18 digits — [ -lt ] chokes past int64
    if ! [[ "$value" =~ ^[0-9]{1,18}$ ]]; then
        echo "ERROR: $name must be an integer (got: '$value')" >&2
        exit 1
    fi
    if [ "$value" -lt "$min" ]; then
        echo "ERROR: $name must be >= $min (got: $value)" >&2
        exit 1
    fi
    if [ -n "$max" ] && [ "$value" -gt "$max" ]; then
        echo "ERROR: $name must be <= $max (got: $value)" >&2
        exit 1
    fi
}

validate_port() {
    validate_int "$1" "$2" 1 65535
}

# the panel's "boolean" fields can hand us 1/true/yes/on in any case
is_truthy() {
    case "${1,,}" in
        1|true|yes|on) return 0 ;;
        *) return 1 ;;
    esac
}

yaml_dquote() {
    printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

# Blank = "size it for me". Would've liked an 'auto' keyword in the panel
# field, but Laravel splits rules on '|' so a regex with alternation 500s the
# panel (learned that the hard way). 'auto' still works if typed.
VM_DISK_GB="${VM_DISK_GB:-auto}"
VM_RAM_MB="${VM_RAM_MB:-auto}"
VM_CPU_CORES="${VM_CPU_CORES:-1}"
SERVER_PORT="${SERVER_PORT:-2222}"
DISPLAY_MODE="${DISPLAY_MODE:-ssh}"
UEFI="${UEFI:-0}"
ADDITIONAL_PORTS="${ADDITIONAL_PORTS:-}"
BLOCKED_PORTS="${BLOCKED_PORTS:-}"
OS_HOSTNAME="${OS_HOSTNAME:-aerovm}"
OS_PASSWORD="${OS_PASSWORD:-}"
OS_PUBKEY="${OS_PUBKEY:-}"
PACKAGE_UPDATE="${PACKAGE_UPDATE:-0}"
IPV4_MODE="${IPV4_MODE:-open}"
OVERWRITE_HOST="${OVERWRITE_HOST:-}"
OVERWRITE_IP="${OVERWRITE_IP:-}"
BANNER="${BANNER:-}"
CLOUD_OS_FAMILY="${CLOUD_OS_FAMILY:-}"
KVM="${KVM:-auto}"
if [ -n "${NOKVM:-}" ] && [ "${NOKVM:-}" != "0" ] && [ "${NOKVM:-}" != "false" ]; then
    KVM="off"
fi
if [ -n "${NO_KVM:-}" ] && [ "${NO_KVM:-}" != "0" ] && [ "${NO_KVM:-}" != "false" ]; then
    KVM="off"
fi
OS_ISO_URL="${OS_ISO_URL:-}"

# Fixed container port the noVNC web server listens on (DISPLAY_MODE=novnc).
NOVNC_PORT=6080

# auto disk = 80% of the panel's Disk Space limit (SERVER_DISK, injected by
# our Wings patch; 0 = unlimited). The 20% slack is for the seed ISO, any
# installer ISOs and qcow2 overhead — go over the panel limit and Wings
# stops the server.
if [[ "${VM_DISK_GB,,}" == "auto" ]]; then
    # 10# everywhere: a leading zero would flip bash arithmetic into octal
    # and abort the script on digits 8/9.
    if [[ "${SERVER_DISK:-}" =~ ^[0-9]{1,12}$ ]] && [ "$((10#$SERVER_DISK))" -gt 0 ]; then
        VM_DISK_GB=$(( 10#$SERVER_DISK * 8 / 10 / 1024 ))
        [ "$VM_DISK_GB" -lt 1 ] && VM_DISK_GB=1
        echo "INFO: VM_DISK_GB=auto -> ${VM_DISK_GB}G (80% of the panel's ${SERVER_DISK}MB disk limit)"
    else
        VM_DISK_GB=20
        echo "INFO: VM_DISK_GB=auto, but the node doesn't expose SERVER_DISK (Wings KVM patch not applied, or Disk Space is unlimited) — using the default 20G"
    fi
fi

# auto RAM = 80% of the memory limit (SERVER_MEMORY comes from stock Wings).
# QEMU itself needs the other 20% or the cgroup OOM-kills us.
if [[ "${VM_RAM_MB,,}" == "auto" ]]; then
    if [[ "${SERVER_MEMORY:-}" =~ ^[0-9]{1,12}$ ]] && [ "$((10#$SERVER_MEMORY))" -gt 0 ]; then
        VM_RAM_MB=$(( 10#$SERVER_MEMORY * 8 / 10 ))
        [ "$VM_RAM_MB" -lt 128 ] && VM_RAM_MB=128
        echo "INFO: VM_RAM_MB=auto -> ${VM_RAM_MB}MB (80% of the panel's ${SERVER_MEMORY}MB memory limit)"
    else
        VM_RAM_MB=1024
        echo "INFO: VM_RAM_MB=auto with an unlimited panel memory limit — using the default 1024MB"
    fi
fi

# maxes keep the byte math below int64
validate_int "VM_DISK_GB" "$VM_DISK_GB" 1 1048576
validate_int "VM_RAM_MB" "$VM_RAM_MB" 128 16777216
validate_int "VM_CPU_CORES" "$VM_CPU_CORES" 1 16
validate_port "SERVER_PORT" "$SERVER_PORT"

# VM RAM >= container limit means the cgroup will eventually kill QEMU with
# zero explanation. People read that as "my VM randomly dies". Warn loudly.
if [[ "${SERVER_MEMORY:-}" =~ ^[0-9]{1,12}$ ]] && [ "$((10#$SERVER_MEMORY))" -gt 0 ] && [ "$VM_RAM_MB" -ge "$((10#$SERVER_MEMORY))" ]; then
    echo "WARNING: VM_RAM_MB (${VM_RAM_MB}MB) is at or above the server's memory limit (${SERVER_MEMORY}MB)." >&2
    echo "         QEMU needs headroom on top of the guest's RAM; the container risks being OOM-killed." >&2
    echo "         Lower VM_RAM_MB (or leave it blank = automatic 80%), or raise the server's memory limit." >&2
fi

case "$DISPLAY_MODE" in
    ssh|vnc|novnc|spice|rdp|none) ;;
    *)
        echo "ERROR: DISPLAY_MODE must be one of: ssh, vnc, novnc, spice, rdp, none" >&2
        exit 1
        ;;
esac

case "$IPV4_MODE" in
    disabled|user|all|open) ;;
    *)
        echo "ERROR: IPV4_MODE must be one of: open, disabled, user, all" >&2
        exit 1
        ;;
esac

# Ports the VM must never receive, as a set. Accepts single ports and ranges,
# same separators as ADDITIONAL_PORTS. Only meaningful next to IPV4_MODE=open,
# but it's honoured in every mode so a port listed here is closed, full stop.
declare -A BLOCKED_SET=()
BLOCKED_SPEC=""
if [ -n "$BLOCKED_PORTS" ]; then
    while IFS= read -r entry; do
        [ -z "$entry" ] && continue
        if [[ "$entry" =~ ^([0-9]{1,5})-([0-9]{1,5})$ ]]; then
            lo="$((10#${BASH_REMATCH[1]}))"; hi="$((10#${BASH_REMATCH[2]}))"
        elif [[ "$entry" =~ ^([0-9]{1,5})$ ]]; then
            lo="$((10#${BASH_REMATCH[1]}))"; hi="$lo"
        else
            echo "WARNING: Skipping invalid BLOCKED_PORTS entry: '$entry'" >&2
            continue
        fi
        if [ "$lo" -lt 1 ] || [ "$hi" -gt 65535 ] || [ "$lo" -gt "$hi" ]; then
            echo "WARNING: Skipping out-of-range BLOCKED_PORTS entry: '$entry'" >&2
            continue
        fi
        # Locking yourself out of the box is not a thing we let happen: the
        # primary port is the only way back in when SSH is the display mode.
        if [ "$lo" -le "$((10#$SERVER_PORT))" ] && [ "$((10#$SERVER_PORT))" -le "$hi" ]; then
            echo "WARNING: BLOCKED_PORTS covers the server's primary port ${SERVER_PORT} — keeping that one open so you don't lose access" >&2
        fi
        for ((bp = lo; bp <= hi; bp++)); do
            [ "$bp" -eq "$((10#$SERVER_PORT))" ] && continue
            BLOCKED_SET[$bp]=1
        done
        if [ "$lo" -eq "$hi" ]; then
            BLOCKED_SPEC="${BLOCKED_SPEC:+$BLOCKED_SPEC,}~${lo}"
        else
            BLOCKED_SPEC="${BLOCKED_SPEC:+$BLOCKED_SPEC,}~${lo}-${hi}"
        fi
    done <<< "$(echo "$BLOCKED_PORTS" | tr ', ;' '\n')"
    [ "${#BLOCKED_SET[@]}" -gt 0 ] && echo "INFO: keeping ${#BLOCKED_SET[@]} port(s) closed: ${BLOCKED_PORTS}"
fi

KVM_LOWER="$(echo "${KVM:-auto}" | tr '[:upper:]' '[:lower:]')"
case "$KVM_LOWER" in
    1|true|yes|on) KVM="on" ;;
    0|false|no|off|nokvm) KVM="off" ;;
    auto) KVM="auto" ;;
    *)
        echo "ERROR: KVM must be one of: on, off, nokvm, auto (got: '$KVM')" >&2
        exit 1
        ;;
esac

# RFC 952/1123: labels are letters/digits/hyphens, 1-63 chars, and must not
# start or end with a hyphen (guests reject such hostnames).
if ! [[ "$OS_HOSTNAME" =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$ ]]; then
    echo "ERROR: OS_HOSTNAME must be 1-63 letters, numbers, and hyphens, and must not start or end with a hyphen (got: '$OS_HOSTNAME')" >&2
    exit 1
fi

if [[ "$OVERWRITE_HOST" == *","* ]] || [[ "$OVERWRITE_HOST" == *"\""* ]]; then
    echo "ERROR: OVERWRITE_HOST must not contain commas or quotes" >&2
    exit 1
fi

# OS_PASSWORD is written verbatim into a cloud-init chpasswd "user:password"
# line, which is newline-delimited, so a newline would corrupt the structure.
if [[ "$OS_PASSWORD" == *$'\n'* ]] || [[ "$OS_PASSWORD" == *$'\r'* ]]; then
    echo "ERROR: OS_PASSWORD must not contain newline characters" >&2
    exit 1
fi

# OS_PUBKEY is embedded in a double-quoted YAML scalar; a newline there would
# break the document.
if [[ "$OS_PUBKEY" == *$'\n'* ]] || [[ "$OS_PUBKEY" == *$'\r'* ]]; then
    echo "ERROR: OS_PUBKEY must not contain newline characters" >&2
    exit 1
fi

BASE_IMAGE="/opt/base-image/base.qcow2"
CLOUD_INIT_MODE=0
[ -f "$BASE_IMAGE" ] && CLOUD_INIT_MODE=1

# rdp on a blank disk: nothing to auto-install, but the OS the user put on it
# (Windows, Linux+xrdp) might speak RDP already, so forward 3389 and warn
# instead of refusing.
if [ "$DISPLAY_MODE" = "rdp" ] && [ "$CLOUD_INIT_MODE" -ne 1 ]; then
    echo "WARNING: DISPLAY_MODE=rdp on a blank-disk image only forwards port 3389 — your installed guest OS must provide the RDP service itself. Use vnc/novnc to install the OS first." >&2
fi

# primary port = 3389 in rdp mode would shadow the RDP forward with SSH
if [ "$DISPLAY_MODE" = "rdp" ] && [ "$((10#$SERVER_PORT))" -eq 3389 ]; then
    echo "ERROR: DISPLAY_MODE=rdp needs host port 3389, but the server's primary port is also 3389; assign a different primary port" >&2
    exit 1
fi

# If the primary port lands on a display listener port, the SSH forward gets
# skipped as reserved and the VM comes up unreachable. Refuse instead.
case "$DISPLAY_MODE" in
    vnc|spice)
        if [ "$((10#$SERVER_PORT))" -eq 5900 ]; then
            echo "ERROR: DISPLAY_MODE=${DISPLAY_MODE} uses port 5900 for the display, but the server's primary port is also 5900; assign a different primary port" >&2
            exit 1
        fi
        ;;
    novnc)
        if [ "$((10#$SERVER_PORT))" -eq 5900 ] || [ "$((10#$SERVER_PORT))" -eq "$NOVNC_PORT" ]; then
            echo "ERROR: DISPLAY_MODE=novnc uses ports 5900 and ${NOVNC_PORT}, but the server's primary port collides with one of them; assign a different primary port" >&2
            exit 1
        fi
        ;;
esac

needs_desktop=0
case "$DISPLAY_MODE" in
    vnc|novnc|spice|rdp) [ "$CLOUD_INIT_MODE" -eq 1 ] && needs_desktop=1 ;;
esac

if [ "$needs_desktop" -eq 1 ]; then
    case "$CLOUD_OS_FAMILY" in
        debian|fedora|rhel|arch) ;;
        *)
            echo "ERROR: DISPLAY_MODE=${DISPLAY_MODE} needs a desktop environment, but this image has no recognized CLOUD_OS_FAMILY ('${CLOUD_OS_FAMILY}')" >&2
            exit 1
            ;;
    esac
fi

# One password for everything: guest root AND the VNC/SPICE display. If we
# generate it, keep it in a file so every boot agrees on it.
GENERATED_PW_FILE="/home/container/.aerovm-root-password"
need_password=0
[ "$CLOUD_INIT_MODE" -eq 1 ] && need_password=1
case "$DISPLAY_MODE" in vnc|novnc|spice) need_password=1 ;; esac

password="$OS_PASSWORD"
if [ "$need_password" -eq 1 ] && [ -z "$password" ]; then
    # empty/corrupt file falls through to regeneration — an empty password
    # must never reach the guest or the display auth
    if [ -f "$GENERATED_PW_FILE" ]; then
        password="$(cat "$GENERATED_PW_FILE")"
    fi
    if [ -n "$password" ]; then
        echo "INFO: OS_PASSWORD is empty; using the saved auto-generated password: ${password}"
    else
        password="$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 20 || true)"
        if [ -z "$password" ]; then
            echo "ERROR: Failed to generate a random password" >&2
            exit 1
        fi
        (umask 077; printf '%s\n' "$password" > "$GENERATED_PW_FILE")
        echo "INFO: OS_PASSWORD was empty; generated a password: ${password}"
    fi
fi



QEMU_ACCEL=()

# aio=native needs O_DIRECT, which fights cache=writeback (qemu refuses to
# start) and doesn't work on every node fs anyway. threads runs everywhere,
# and the performance that matters comes from KVM, not the AIO backend.
AIO_MODE="threads"
CACHE_MODE="writeback"

kvm_usable=0
if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then
    kvm_usable=1
fi

# Is the node itself a VM? The container shares the host kernel, so the
# "hypervisor" CPU flag tells us. KVM inside a VM = nested virt, which has
# kernel-panicked a real node during testing (AMD hosts especially) — so in
# auto mode we take the slow-but-safe route. KVM=on overrides.
nested_virt=0
if grep -qw hypervisor /proc/cpuinfo 2>/dev/null; then
    nested_virt=1
fi

# TCG CPU model. Not qemu64: it predates x86-64-v2, and Rocky/Alma 9 die on
# it with "Fatal glibc error: CPU does not support x86-64-v2". max gives TCG
# everything it can emulate.
TCG_CPU="max"

if [ "$KVM" = "off" ]; then
    QEMU_ACCEL=(-cpu "$TCG_CPU")
    echo "INFO: KVM disabled (KVM=off), using software emulation"
elif [ "$KVM" = "on" ]; then
    if [ "$kvm_usable" -ne 1 ]; then
        echo "ERROR: KVM=on but /dev/kvm is not available/writable in the container" >&2
        echo "       Apply the Wings KVM patch (wings-patch/install.sh) or set KVM=auto/off" >&2
        exit 1
    fi
    QEMU_ACCEL=(-enable-kvm -cpu host)
    echo "INFO: KVM enabled (KVM=on)"
    [ "$nested_virt" -eq 1 ] && echo "WARNING: node appears virtualized; forced nested KVM (KVM=on) can crash the host if it doesn't support stable nested virtualization"
elif [ "$kvm_usable" -eq 1 ] && [ "$nested_virt" -eq 1 ]; then
    # /dev/kvm exists but we're nested — not worth a host panic
    QEMU_ACCEL=(-cpu "$TCG_CPU")
    echo "INFO: node is virtualized (nested) — using software emulation to avoid host-crashing nested KVM. Set KVM=on to force KVM if your host supports stable nested virtualization."
elif [ "$kvm_usable" -eq 1 ]; then
    QEMU_ACCEL=(-enable-kvm -cpu host)
    echo "INFO: KVM enabled"
else
    QEMU_ACCEL=(-cpu "$TCG_CPU")
    echo "INFO: KVM not available, using software emulation"
fi



DISK_IMAGE="/home/container/disk.qcow2"
BASE_ID_FILE="/home/container/.aerovm-base-id"

# cheap fingerprint of the bundled base image (size + first 4MB) — enough to
# notice the Docker image was switched to a different guest OS
base_image_id() {
    { stat -c %s "$BASE_IMAGE" 2>/dev/null; head -c 4194304 "$BASE_IMAGE" | sha256sum; } | sha256sum | cut -c1-16
}

PROVISIONED_NOW=0
if [ ! -f "$DISK_IMAGE" ]; then
    PROVISIONED_NOW=1
    if [ "$CLOUD_INIT_MODE" -eq 1 ]; then
        echo "INFO: Provisioning disk from bundled cloud image"
        cp "$BASE_IMAGE" "$DISK_IMAGE" \
            || { echo "ERROR: Failed to copy base cloud image" >&2; exit 1; }
        chmod 666 "$DISK_IMAGE" 2>/dev/null || true
        base_image_id > "$BASE_ID_FILE"
    else
        qemu-img create -f qcow2 "$DISK_IMAGE" "${VM_DISK_GB}G" \
            || { echo "ERROR: Failed to create disk image" >&2; exit 1; }
    fi
elif [ "$CLOUD_INIT_MODE" -eq 1 ]; then
    # Disk already exists. Switching the Docker image does NOT reinstall it
    # (data stays), which surprises people — tell them how to actually switch.
    if [ -f "$BASE_ID_FILE" ]; then
        if [ "$(cat "$BASE_ID_FILE")" != "$(base_image_id)" ]; then
            echo "WARNING: This server's Docker image bundles a different guest OS than disk.qcow2 was installed from." >&2
            echo "         The existing disk (and its OS) keeps booting. To reinstall with the new OS, delete" >&2
            echo "         disk.qcow2 (and the .aerovm-* files) in the panel's file manager, then restart. This erases the VM's data." >&2
        fi
    else
        # deployment from before we tracked this — adopt the current base
        base_image_id > "$BASE_ID_FILE"
    fi
fi

# A truncated/corrupt disk.qcow2 (a disk-quota kill mid-write can do this)
# would otherwise die later with only qemu's raw error. -f qcow2 matters:
# without it qemu-img happily "detects" garbage as a raw image.
if ! disk_info="$(qemu-img info -f qcow2 "$DISK_IMAGE" 2>&1)"; then
    echo "ERROR: disk.qcow2 is unreadable (corrupt or truncated):" >&2
    echo "       ${disk_info}" >&2
    echo "       Delete disk.qcow2 (and the .aerovm-* files) in the panel's file manager and" >&2
    echo "       restart to reprovision. This erases the VM's data." >&2
    exit 1
fi

# Grow the disk to VM_DISK_GB on every boot, not just at provisioning, so a
# raised value (or a raised panel limit, with auto sizing) applies on the next
# restart. cloud-init guests grow their partition/fs themselves every boot;
# blank-disk guests have to do it by hand. Never shrink — that corrupts.
current_bytes="$(sed -n '/bytes)/{s/.*(\([0-9]*\) bytes).*/\1/p;q}' <<< "$disk_info")"
[[ "$current_bytes" =~ ^[0-9]+$ ]] || current_bytes=0
requested_bytes=$(( 10#$VM_DISK_GB * 1024 * 1024 * 1024 ))
if [ "$requested_bytes" -gt "$current_bytes" ]; then
    qemu-img resize "$DISK_IMAGE" "${VM_DISK_GB}G" \
        || { echo "ERROR: Failed to resize disk image" >&2; exit 1; }
    if [ "$current_bytes" -gt 0 ]; then
        echo "INFO: Disk grown to ${VM_DISK_GB}G"
        if [ "$CLOUD_INIT_MODE" -eq 1 ]; then
            echo "      The guest partition/filesystem will grow automatically during boot."
        else
            echo "      Grow the partition and filesystem inside your guest OS to use the new space."
        fi
    fi
elif [ "$requested_bytes" -lt "$current_bytes" ] && [ "$requested_bytes" -gt 0 ]; then
    echo "INFO: VM_DISK_GB (${VM_DISK_GB}G) is smaller than the current disk; shrinking is not supported, keeping the current size"
fi

build_desktop_runcmd() {
    # desktop images have everything baked in already — just the autologin
    # group wiring is left (the aerovm user only exists at runtime)
    if [ "${prebaked:-0}" -eq 1 ]; then
        if [ "$DISPLAY_MODE" != "rdp" ]; then
            echo "  - groupadd -f autologin"
            echo "  - gpasswd -a aerovm autologin 2>/dev/null || usermod -aG autologin aerovm || true"
        fi
        return
    fi

    case "$CLOUD_OS_FAMILY" in
        debian)
            echo "  - apt-get update"
            echo "  - DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xfce4 lightdm"
            [ "$DISPLAY_MODE" = "spice" ] && echo "  - DEBIAN_FRONTEND=noninteractive apt-get install -y spice-vdagent"
            if [ "$DISPLAY_MODE" = "rdp" ]; then
                echo "  - DEBIAN_FRONTEND=noninteractive apt-get install -y xrdp"
                echo "  - systemctl enable --now xrdp"
            fi
            ;;
        fedora)
            echo "  - dnf install -y xfce4-session lightdm"
            [ "$DISPLAY_MODE" = "spice" ] && echo "  - dnf install -y spice-vdagent"
            if [ "$DISPLAY_MODE" = "rdp" ]; then
                echo "  - dnf install -y xrdp"
                echo "  - systemctl enable --now xrdp"
            fi
            ;;
        rhel)
            echo "  - dnf install -y dnf-plugins-core epel-release"
            echo "  - dnf config-manager --set-enabled crb"
            echo "  - dnf install -y xfce4-session lightdm"
            [ "$DISPLAY_MODE" = "spice" ] && echo "  - dnf install -y spice-vdagent"
            if [ "$DISPLAY_MODE" = "rdp" ]; then
                echo "  - dnf install -y xrdp"
                echo "  - systemctl enable --now xrdp"
            fi
            ;;
        arch)
            echo "  - pacman -Syu --noconfirm xfce4 lightdm lightdm-gtk-greeter"
            [ "$DISPLAY_MODE" = "spice" ] && echo "  - pacman -S --noconfirm spice-vdagent"
            if [ "$DISPLAY_MODE" = "rdp" ]; then
                echo "  - pacman -S --noconfirm xrdp"
                echo "  - systemctl enable --now xrdp"
            fi
            ;;
    esac

    if [ "$DISPLAY_MODE" != "rdp" ]; then
        # LightDM autologin needs the target user in the 'autologin' group on
        # some distros; the drop-in config is written via write_files.
        echo "  - groupadd -f autologin"
        echo "  - gpasswd -a aerovm autologin 2>/dev/null || usermod -aG autologin aerovm || true"
        echo "  - systemctl enable lightdm"
        echo "  - systemctl set-default graphical.target || true"
    fi
}

CDROM_OPTS=()
BOOT_ORDER="c"
if [ "$CLOUD_INIT_MODE" -eq 1 ]; then
    if [ -n "$OS_ISO_URL" ]; then
        echo "WARNING: OS_ISO_URL is ignored on ready-to-use (cloud-init) images; it is only for the blank-disk images" >&2
    fi
    SEED_ISO="/home/container/seed.iso"

    pkg_update="false"
    is_truthy "$PACKAGE_UPDATE" && pkg_update="true"

    legacy_fmt=0
    is_truthy "${CLOUD_INIT_LEGACY:-0}" && legacy_fmt=1

    prebaked=0
    is_truthy "${CLOUD_DESKTOP_PREBAKED:-0}" && prebaked=1

    # instance-id = hash of everything that shapes user-data. cloud-init only
    # re-provisions when the id changes, so: same settings, same id, restarts
    # do nothing; change the password in the panel and it actually applies on
    # the next restart. Side effect: the guest regenerates SSH host keys after
    # a settings change, so ssh clients get a one-time host-key warning.
    instance_id="aerovm-$(printf '%s\n' "$OS_HOSTNAME" "$password" "$OS_PUBKEY" "$DISPLAY_MODE" "$pkg_update" "$CLOUD_OS_FAMILY" "$legacy_fmt" "$prebaked" | sha256sum | cut -c1-16)"

    pwauth="true"
    root_keys_yaml=""
    if [ -n "$OS_PUBKEY" ]; then
        pwauth="false"
        root_keys_yaml=$'    ssh_authorized_keys:\n      - "'"$(yaml_dquote "$OS_PUBKEY")"'"'
    fi

    seed_dir="$(mktemp -d)"
    hostname_esc="$(yaml_dquote "$OS_HOSTNAME")"
    # escaped for the double-quoted YAML scalar below; the parser un-escapes
    password_esc="$(yaml_dquote "$password")"

    desktop_users_yaml=""
    if [ "$needs_desktop" -eq 1 ]; then
        desktop_users_yaml=$'  - name: aerovm\n    lock_passwd: false\n    sudo: ALL=(ALL) NOPASSWD:ALL\n    shell: /bin/bash'
        if [ "$prebaked" -eq 1 ]; then
            echo "INFO: desktop is preinstalled in this image — ready shortly after boot"
        else
            echo "INFO: DISPLAY_MODE=${DISPLAY_MODE} requires a desktop environment; cloud-init will install it on first boot (may take a few minutes)"
        fi
    fi

    # chpasswd `users` needs cloud-init >= 22.3; Debian 10/11 ship 20.x and
    # silently ignore it (password never set — fun to debug). Those images set
    # CLOUD_INIT_LEGACY=1 and get the old `list` form. Its literal block takes
    # the password raw, no escaping.
    if [ "$legacy_fmt" -eq 1 ]; then
        chpasswd_yaml=$'chpasswd:\n  expire: false\n  list: |\n    root:'"${password}"
        [ "$needs_desktop" -eq 1 ] && chpasswd_yaml+=$'\n    aerovm:'"${password}"
    else
        chpasswd_yaml=$'chpasswd:\n  expire: false\n  users:\n    - {name: root, password: "'"${password_esc}"'", type: text}'
        [ "$needs_desktop" -eq 1 ] && chpasswd_yaml+=$'\n    - {name: aerovm, password: "'"${password_esc}"'", type: text}'
    fi

    # EOL guests whose apt mirrors moved to the archive hosts can't install
    # anything out of the box (desktop, PACKAGE_UPDATE). Their images set
    # CLOUD_ARCHIVE_FIX and we repoint the sources early on every boot —
    # bootcmd runs before the package modules.
    archive_bootcmd_yaml=""
    case "${CLOUD_ARCHIVE_FIX:-}" in
        debian10)
            archive_bootcmd_yaml=$'bootcmd:\n  - [sed, -i, -e, \'s|deb.debian.org/debian|archive.debian.org/debian|g\', -e, \'s|security.debian.org|archive.debian.org|g\', -e, \'/buster-updates/d\', /etc/apt/sources.list]\n  - [sh, -c, \'printf \'\'Acquire::Check-Valid-Until "false";\'\' > /etc/apt/apt.conf.d/99-aerovm-archive || true\']'
            ;;
        ubuntu-old)
            archive_bootcmd_yaml=$'bootcmd:\n  - [sed, -i, -e, \'s|//archive.ubuntu.com/ubuntu|//old-releases.ubuntu.com/ubuntu|g\', -e, \'s|//security.ubuntu.com/ubuntu|//old-releases.ubuntu.com/ubuntu|g\', /etc/apt/sources.list]'
            ;;
    esac

    write_files_entries=""
    runcmd_body=""
    # qemu's pc machine has a floppy controller nobody asked for; guest
    # kernels probe it and spam "I/O error, dev fd0". Blacklist it (quiet
    # from the second boot onward).
    write_files_entries+=$'\n  - path: /etc/modprobe.d/blacklist-floppy.conf\n    content: |\n      blacklist floppy'
    # cloud images ship PermitRootLogin=prohibit-password, which blocks root
    # password logins even with ssh_pwauth on — drop in a config when we're
    # doing password auth. Key auth works fine with the default.
    if [ "$pwauth" = "true" ]; then
        write_files_entries+=$'\n  - path: /etc/ssh/sshd_config.d/99-aerovm.conf\n    content: |\n      PermitRootLogin yes\n      PasswordAuthentication yes'
        runcmd_body=$'  - sed -i \'s/^#*PermitRootLogin.*/PermitRootLogin yes/\' /etc/ssh/sshd_config\n  - systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || true'
    fi
    # vnc/novnc/spice go straight to the desktop, no greeter; rdp logs in itself
    if [ "$needs_desktop" -eq 1 ] && [ "$DISPLAY_MODE" != "rdp" ]; then
        write_files_entries+=$'\n  - path: /etc/lightdm/lightdm.conf.d/50-aerovm.conf\n    content: |\n      [Seat:*]\n      autologin-user=aerovm\n      autologin-user-timeout=0'
    fi
    write_files_yaml=""
    [ -n "$write_files_entries" ] && write_files_yaml="write_files:${write_files_entries}"

    if [ "$needs_desktop" -eq 1 ]; then
        [ -n "$runcmd_body" ] && runcmd_body+=$'\n'
        runcmd_body+="$(build_desktop_runcmd)"
    fi
    runcmd_yaml=""
    [ -n "$runcmd_body" ] && runcmd_yaml="runcmd:"$'\n'"$runcmd_body"

    cat > "${seed_dir}/meta-data" <<EOF
instance-id: ${instance_id}
local-hostname: "${hostname_esc}"
EOF

    cat > "${seed_dir}/user-data" <<EOF
#cloud-config
hostname: "${hostname_esc}"
manage_etc_hosts: true
disable_root: false
ssh_pwauth: ${pwauth}
package_update: ${pkg_update}
package_upgrade: ${pkg_update}
mounts:
  - [shared, /shared, 9p, "trans=virtio,version=9p2000.L,msize=512000,rw,nofail,_netdev", "0", "0"]
${archive_bootcmd_yaml}
${chpasswd_yaml}
users:
  - name: root
${root_keys_yaml}
${desktop_users_yaml}
${write_files_yaml}
${runcmd_yaml}
EOF

    xorriso -as mkisofs -output "$SEED_ISO" -volid cidata -joliet -rock \
        "${seed_dir}/user-data" "${seed_dir}/meta-data" >/dev/null 2>&1 \
        || { echo "ERROR: Failed to build cloud-init seed image" >&2; exit 1; }

    rm -rf "$seed_dir"

    CDROM_OPTS=(-cdrom "$SEED_ISO")
else
    # Blank disk: boot whatever installer the user gives us — an uploaded
    # os.iso, or OS_ISO_URL which we download once. boot order=cd is the
    # trick: an empty disk falls through to the ISO, an installed one boots
    # itself even with the ISO still attached.
    INSTALLER_ISO="/home/container/os.iso"

    if [ ! -f "$INSTALLER_ISO" ] && [ -n "$OS_ISO_URL" ]; then
        case "$OS_ISO_URL" in
            http://*|https://*) ;;
            *)
                echo "ERROR: OS_ISO_URL must be an http:// or https:// URL (got: '$OS_ISO_URL')" >&2
                exit 1
                ;;
        esac
        if ! command -v curl >/dev/null 2>&1; then
            echo "ERROR: curl is not available in this image; upload the installer as os.iso manually instead" >&2
            exit 1
        fi
        echo "INFO: Downloading installer ISO (this can take a while)..."
        echo "      ${OS_ISO_URL}"
        # -C - picks up a leftover .part instead of redownloading gigabytes.
        # If resume fails (no range support / corrupt partial), one clean
        # retry; total failure leaves nothing behind.
        if ! curl -fL --retry 3 --retry-all-errors -C - -o "${INSTALLER_ISO}.part" "$OS_ISO_URL"; then
            echo "INFO: Resume failed, retrying the download from scratch..."
            rm -f "${INSTALLER_ISO}.part"
            if ! curl -fL --retry 3 --retry-all-errors -o "${INSTALLER_ISO}.part" "$OS_ISO_URL"; then
                rm -f "${INSTALLER_ISO}.part"
                echo "ERROR: Failed to download the installer ISO from OS_ISO_URL" >&2
                exit 1
            fi
        fi
        mv "${INSTALLER_ISO}.part" "$INSTALLER_ISO"
        echo "INFO: Installer ISO saved as os.iso"
    fi

    # explicit IDE drives (index 2/3) so a driver ISO — virtio-win, for
    # Windows installs — can sit next to the installer
    if [ -f "$INSTALLER_ISO" ]; then
        CDROM_OPTS+=(-drive "file=${INSTALLER_ISO},if=ide,index=2,media=cdrom,readonly=on")
        BOOT_ORDER="cd"
        echo "INFO: Installer ISO attached (os.iso). It boots while the disk is empty."
        echo "      After installing your OS, delete os.iso and clear OS_ISO_URL."
        case "$DISPLAY_MODE" in
            ssh|none)
                echo "WARNING: Most OS installers need a display; set DISPLAY_MODE to vnc or novnc to interact with the installer" >&2
                ;;
        esac
    fi

    DRIVERS_ISO="/home/container/drivers.iso"
    if [ -f "$DRIVERS_ISO" ]; then
        CDROM_OPTS+=(-drive "file=${DRIVERS_ISO},if=ide,index=3,media=cdrom,readonly=on")
        echo "INFO: Extra driver ISO attached as a second CD-ROM (drivers.iso)."
        echo "      For a Windows install, point Setup's disk-driver load at it (virtio-win)."
    fi
fi



# Every forward as a "host guest" line — deduped, display listener ports
# excluded. Both network backends build their args from this one list so they
# can never disagree.
build_fwd_list() {
    declare -A seen_host_ports=()
    declare -A reserved_ports=()

    # never forward a port the display listener itself binds — qemu either
    # refuses to start or the forward silently steals the traffic
    case "$DISPLAY_MODE" in
        vnc|spice) reserved_ports[5900]=1 ;;
        novnc)     reserved_ports[5900]=1; reserved_ports[$NOVNC_PORT]=1 ;;
    esac

    add_fwd() {
        local host_p="$1" guest_p="$2"
        if [ -n "${BLOCKED_SET[$host_p]:-}" ]; then
            echo "WARNING: Skipping port ${host_p}: listed in BLOCKED_PORTS" >&2
            return
        fi
        if [ -n "${reserved_ports[$host_p]:-}" ]; then
            echo "WARNING: Skipping port ${host_p}: reserved by DISPLAY_MODE=${DISPLAY_MODE}" >&2
            return
        fi
        if [ -n "${seen_host_ports[$host_p]:-}" ]; then
            echo "WARNING: Skipping duplicate host port forward: ${host_p} (already forwarded to guest port ${seen_host_ports[$host_p]})" >&2
            return
        fi
        seen_host_ports[$host_p]="$guest_p"
        echo "$host_p $guest_p"
    }

    add_fwd "$((10#$SERVER_PORT))" 22

    if [ "$DISPLAY_MODE" = "rdp" ]; then
        add_fwd 3389 3389
    fi

    if [ "$IPV4_MODE" = "all" ]; then
        echo "INFO: IPV4_MODE=all forwards ports 1-1024" >&2
        local p
        for ((p = 1; p <= 1024; p++)); do
            add_fwd "$p" "$p"
        done
    fi

    # Wings with the AeroVM patch hands us the panel's allocation list. Those
    # are exactly the ports the outside world can reach, so in open mode every
    # one of them goes to the VM. This is also what keeps the slirp fallback
    # useful: it can't open all 65k ports, but it can open these.
    if [ "$IPV4_MODE" = "open" ] && [ -n "${SERVER_ALLOCATIONS:-}" ]; then
        local ap
        while IFS= read -r ap; do
            [[ "$ap" =~ ^[0-9]{1,5}$ ]] || continue
            ap="$((10#$ap))"
            [ "$ap" -ge 1 ] && [ "$ap" -le 65535 ] || continue
            # the primary port is an allocation too — already forwarded to 22
            [ -n "${seen_host_ports[$ap]:-}" ] && continue
            add_fwd "$ap" "$ap"
        done <<< "$(echo "$SERVER_ALLOCATIONS" | tr ', ;' '\n')"
    fi

    if [ "$IPV4_MODE" != "disabled" ] && [ -n "$ADDITIONAL_PORTS" ]; then
        local mapping host_p guest_p
        while IFS= read -r mapping; do
            [[ -z "$mapping" ]] && continue
            if [[ "$mapping" =~ ^([0-9]{1,5})-([0-9]{1,5})$ ]]; then
                host_p="${BASH_REMATCH[1]}"
                guest_p="${BASH_REMATCH[2]}"
            elif [[ "$mapping" =~ ^([0-9]{1,5})$ ]]; then
                host_p="${BASH_REMATCH[1]}"
                guest_p="$host_p"
            else
                echo "WARNING: Skipping invalid port mapping: '$mapping'" >&2
                continue
            fi
            if [ "$host_p" -lt 1 ] || [ "$host_p" -gt 65535 ] || [ "$guest_p" -lt 1 ] || [ "$guest_p" -gt 65535 ]; then
                echo "WARNING: Skipping out-of-range port mapping: '$mapping'" >&2
                continue
            fi
            add_fwd "$((10#$host_p))" "$((10#$guest_p))"
        done <<< "$(echo "$ADDITIONAL_PORTS" | tr ', ;' '\n')"
    fi
}

NOVNC_PID=""
NOVNC_LOG="/home/container/.novnc.log"

FWD_LIST="$(build_fwd_list)"

# IPV4_MODE=open means "don't make people re-declare ports they already own".
# Wings only publishes the allocations the panel gave this server, so anything
# else is unreachable from outside no matter what we forward — the allocation
# list is the real gate. We just stop second-guessing it and pass everything
# through, minus BLOCKED_PORTS and whatever the display listener needs.
OPEN_ALL=0
[ "$IPV4_MODE" = "open" ] && OPEN_ALL=1

# Network backend. passt beats qemu's built-in slirp on throughput by a wide
# margin and takes big port lists in stride, but it isn't packaged everywhere
# (the Ubuntu blank images don't have it) and some node kernels refuse its
# sandboxing — so it's opportunistic with a hard fallback to slirp.
# AEROVM_NET=slirp forces the old path.
NET_BACKEND="slirp"
PASST_SOCK="/tmp/aerovm-passt.sock"
PASST_LOG="/home/container/.passt.log"
PASST_PID=""
if [ "${AEROVM_NET:-auto}" != "slirp" ] && command -v passt >/dev/null 2>&1; then
    passt_spec=""
    passt_udp_spec=""
    if [ "$OPEN_ALL" -eq 1 ]; then
        # passt reads a leading '~' as "everything except this" (its own docs:
        # '-t ~25' forwards all ports but 25), which is exactly the shape we
        # want. Exclusions first, then the handful of ports that land on a
        # different number inside the guest.
        excl=""
        case "$DISPLAY_MODE" in
            vnc|spice) excl="~5900" ;;
            novnc)     excl="~5900,~${NOVNC_PORT}" ;;
        esac
        [ -n "$BLOCKED_SPEC" ] && excl="${excl:+$excl,}$BLOCKED_SPEC"
        # UDP never needs the SSH remap — leaving the primary port alone means
        # a game or voice server on that allocation gets its UDP traffic.
        passt_udp_spec="$excl"
        # A port that lands on a different number in the guest has to be cut
        # out of the blanket range first, otherwise it would also be forwarded
        # straight through and the two rules would fight over it. Carving it
        # out also guarantees the spec starts with a '~', which is what makes
        # passt read the whole thing as "everything except".
        remaps=""
        while read -r h g; do
            [ -z "$h" ] && continue
            [ "$h" = "$g" ] && continue
            excl="${excl:+$excl,}~${h}"
            remaps="${remaps:+$remaps,}${h}:${g}"
        done <<< "$FWD_LIST"
        passt_spec="${excl}${remaps:+${excl:+,}$remaps}"
        # Nothing excluded and nothing remapped still has to mean "everything".
        [ -z "$passt_spec" ] && passt_spec="all"
        [ -z "$passt_udp_spec" ] && passt_udp_spec="all"
    else
        while read -r h g; do
            [ -z "$h" ] && continue
            if [ "$h" = "$g" ]; then s="$h"; else s="$h:$g"; fi
            passt_spec="${passt_spec:+$passt_spec,}$s"
        done <<< "$FWD_LIST"
    fi

    : > "$PASST_LOG"
    rm -f "$PASST_SOCK"
    passt --foreground --socket "$PASST_SOCK" ${passt_spec:+-t "$passt_spec"} ${passt_udp_spec:+-u "$passt_udp_spec"} >>"$PASST_LOG" 2>&1 &
    PASST_PID=$!

    # passt dies fast when a node's kernel or seccomp won't let it set up
    # (no user namespace, etc). Wait for the socket AND confirm the process is
    # still alive a beat later — never hand qemu a socket that's about to
    # vanish, or it fails to start. No restart loop: once qemu connects, passt
    # can't re-attach it anyway, so a flaky passt just means slirp.
    for _ in $(seq 1 50); do
        [ -S "$PASST_SOCK" ] && break
        kill -0 "$PASST_PID" 2>/dev/null || break
        sleep 0.1
    done
    sleep 0.3
    if [ -S "$PASST_SOCK" ] && kill -0 "$PASST_PID" 2>/dev/null; then
        NET_BACKEND="passt"
    else
        kill "$PASST_PID" 2>/dev/null || true
        PASST_PID=""
        rm -f "$PASST_SOCK"
        echo "INFO: passt unavailable on this node — using slirp networking" >&2
    fi
fi

if [ "$NET_BACKEND" = "passt" ]; then
    echo "INFO: networking backend: passt"
    if [ "$OPEN_ALL" -eq 1 ]; then
        echo "INFO: every allocated port reaches the VM (TCP+UDP)${BLOCKED_PORTS:+, except ${BLOCKED_PORTS}} — add ports as Allocations in the panel and they just work"
    fi
    NETDEV_OPTS=(-netdev "stream,id=net0,server=off,addr.type=unix,addr.path=${PASST_SOCK}" -device virtio-net-pci,netdev=net0)
else
    # slirp needs one hostfwd rule per port, so it can't fling the door open
    # to all 65k the way passt does. It doesn't need to: build_fwd_list already
    # turned the panel's allocation list into rules, and allocations are the
    # only ports reachable from outside anyway — so the result is the same set
    # of working ports, just enumerated. The one gap is a Wings without our
    # patch, which sends no allocation list; then only the primary port (plus
    # any Additional Ports) gets through.
    if [ "$OPEN_ALL" -eq 1 ]; then
        if [ -n "${SERVER_ALLOCATIONS:-}" ]; then
            echo "INFO: every allocated port reaches the VM${BLOCKED_PORTS:+, except ${BLOCKED_PORTS}} (slirp path) — add ports as Allocations in the panel and they just work"
        else
            echo "WARNING: slirp networking and no allocation list from Wings (patch not applied?) — only the primary port${ADDITIONAL_PORTS:+ and Additional Ports ($ADDITIONAL_PORTS)} will reach the VM. Update the AeroVM Wings patch, or list the ports in Additional Ports." >&2
        fi
    fi
    hostfwd=""
    while read -r h g; do
        [ -z "$h" ] && continue
        hostfwd="${hostfwd},hostfwd=tcp::${h}-:${g}"
        # open mode is meant to be "the port just works", so match passt and
        # carry UDP too. The explicit modes stay TCP-only, like they always were.
        [ "$OPEN_ALL" -eq 1 ] && hostfwd="${hostfwd},hostfwd=udp::${h}-:${g}"
    done <<< "$FWD_LIST"
    NETDEV_OPTS=(-netdev "user,id=net0${hostfwd}" -device virtio-net-pci,netdev=net0)
fi

cleanup() {
    [ -n "$NOVNC_PID" ] && kill "$NOVNC_PID" 2>/dev/null || true
    [ -n "$PASST_PID" ] && kill "$PASST_PID" 2>/dev/null || true
}
trap cleanup EXIT

start_novnc() {
    local novnc_bin=""
    for bin in novnc_server \
               /usr/share/novnc/utils/novnc_proxy \
               /usr/share/novnc/utils/launch.sh; do
        if command -v "$bin" &>/dev/null || [ -x "$bin" ]; then
            novnc_bin="$bin"
            break
        fi
    done
    [ -z "$novnc_bin" ] && { echo "ERROR: noVNC binary not found" >&2; exit 1; }

    : > "$NOVNC_LOG"
    # supervised: if websockify falls over, browser access shouldn't stay
    # dead until someone restarts the whole server. set +e matters — the
    # inherited errexit would kill the loop on the very crash it's here for.
    (
        set +e
        while true; do
            "$novnc_bin" --listen "$NOVNC_PORT" --vnc localhost:5900 >>"$NOVNC_LOG" 2>&1 || true
            echo "noVNC exited, restarting in 2s" >> "$NOVNC_LOG"
            sleep 2
        done
    ) &
    NOVNC_PID=$!
}

# Sound card for graphical modes. Streaming setups (OBS etc.) capture the
# guest's desktop audio, and that needs an audio device to exist even if
# nobody ever hears it — spice gets real playback to the client, the rest a
# null backend behind a normal-looking HDA codec.
AUDIO_OPTS=()
case "$DISPLAY_MODE" in
    spice)         AUDIO_OPTS=(-audiodev spice,id=snd0 -device intel-hda -device hda-duplex,audiodev=snd0) ;;
    vnc|novnc|rdp) AUDIO_OPTS=(-audiodev none,id=snd0 -device intel-hda -device hda-duplex,audiodev=snd0) ;;
esac

# Shared folder: drop a file into 'shared' via SFTP or the panel's file
# manager and it appears inside the guest. cloud-init guests automount it at
# /shared; on a blank disk mount it yourself:
#   mount -t 9p -o trans=virtio,version=9p2000.L shared /mnt
SHARED_DIR="/home/container/shared"
mkdir -p "$SHARED_DIR"
VIRTFS_OPTS=(-virtfs "local,path=${SHARED_DIR},mount_tag=shared,security_model=none")

# Display auth. An open VNC port is a free console (keyboard included) for
# anyone who can reach it, so vnc/novnc/spice all take the VM password. It
# goes to qemu through a file-backed secret — never on the process list.
DISPLAY_SECRET_OPTS=()
DISPLAY_AUTH_FILE="/home/container/.aerovm-display-secret"
case "$DISPLAY_MODE" in
    vnc|novnc|spice)
        (umask 077; printf '%s' "$password" > "$DISPLAY_AUTH_FILE")
        DISPLAY_SECRET_OPTS=(-object "secret,id=aerovm_display,file=${DISPLAY_AUTH_FILE}")
        case "$DISPLAY_MODE" in
            vnc|novnc) [ "${#password}" -gt 8 ] && echo "INFO: VNC uses only the first 8 characters of the password for authentication" ;;
        esac
        ;;
esac

build_display_opts() {
    case "$DISPLAY_MODE" in
        ssh)
            echo "-nographic -serial mon:stdio"
            ;;
        vnc|novnc)
            echo "-vnc :0,password-secret=aerovm_display -vga virtio"
            ;;
        spice)
            echo "-spice port=5900,password-secret=aerovm_display -vga qxl"
            ;;
        rdp|none)
            echo "-display none"
            ;;
    esac
}

# Absolute pointer for anything graphical. Without one qemu falls back to the
# PS/2 relative mouse, and over VNC that means a rubber-banding cursor that
# never lines up with your own — feels like the whole GUI is lagging even
# when it isn't. usb-tablet works with every guest, installers included.
INPUT_OPTS=()
case "$DISPLAY_MODE" in
    vnc|novnc|spice|rdp) INPUT_OPTS=(-usb -device usb-tablet) ;;
esac

display_host_ref="${OVERWRITE_IP:-${SERVER_IP:-$(hostname)}}"

# everything a first-timer needs, printed before the kernel log buries it
print_connection_info() {
    echo "=============================================================="
    echo " AeroVM  |  ${VM_RAM_MB}MB RAM, ${VM_CPU_CORES} vCPU, ${VM_DISK_GB}G disk"
    echo "--------------------------------------------------------------"
    case "$DISPLAY_MODE" in
        ssh)
            echo " Console:  right here (log in as root when the prompt appears)"
            echo " SSH:      ssh root@${display_host_ref} -p ${SERVER_PORT}"
            ;;
        vnc)
            echo " VNC:      ${display_host_ref}:5900"
            echo " SSH:      ssh root@${display_host_ref} -p ${SERVER_PORT}"
            ;;
        novnc)
            echo " Browser:  http://${display_host_ref}:${NOVNC_PORT}/vnc.html"
            echo " SSH:      ssh root@${display_host_ref} -p ${SERVER_PORT}"
            ;;
        spice)
            echo " SPICE:    ${display_host_ref}:5900 (use a SPICE client)"
            echo " SSH:      ssh root@${display_host_ref} -p ${SERVER_PORT}"
            ;;
        rdp)
            if [ "$CLOUD_INIT_MODE" -eq 1 ]; then
                echo " RDP:      ${display_host_ref}:3389 (user: aerovm)"
            else
                echo " RDP:      ${display_host_ref}:3389 (served by your installed guest OS)"
            fi
            echo " SSH:      ssh root@${display_host_ref} -p ${SERVER_PORT}"
            ;;
        none)
            echo " Headless. SSH: ssh root@${display_host_ref} -p ${SERVER_PORT}"
            ;;
    esac
    if [ "$need_password" -eq 1 ]; then
        echo " Password: ${password}"
    fi
    if [ "$CLOUD_INIT_MODE" -eq 1 ]; then
        echo " Shared:   files put in 'shared' appear at /shared in the VM"
    fi
    if [ "$PROVISIONED_NOW" -eq 1 ] && [ "$CLOUD_INIT_MODE" -eq 1 ]; then
        echo "--------------------------------------------------------------"
        echo " First boot: the OS is provisioning itself — allow a few"
        echo " minutes before logging in (much longer without KVM)."
        if [ "$needs_desktop" -eq 1 ] && ! is_truthy "${CLOUD_DESKTOP_PREBAKED:-0}"; then
            echo " The desktop installs on this boot; it takes extra time."
        fi
    fi
    echo "=============================================================="
}
print_connection_info

[ "$DISPLAY_MODE" = "novnc" ] && start_novnc

read -ra DISPLAY_OPTS <<< "$(build_display_opts)"


UEFI_OPTS=()
if is_truthy "$UEFI"; then
    # only the combined OVMF.fd works with -bios; the split OVMF_CODE.fd
    # variant needs pflash and silently fails to boot if you -bios it.
    # Both our bases (Ubuntu: /usr/share/ovmf, Alpine: /usr/share/OVMF) ship
    # the combined one.
    ovmf=""
    for path in /usr/share/ovmf/OVMF.fd \
                /usr/share/OVMF/OVMF.fd; do
        [ -f "$path" ] && { ovmf="$path"; break; }
    done
    [ -z "$ovmf" ] && { echo "ERROR: UEFI=1 but OVMF firmware (OVMF.fd) not found" >&2; exit 1; }
    UEFI_OPTS=(-bios "$ovmf")
fi

SMBIOS_OPTS=()
if [ -n "$OVERWRITE_HOST" ]; then
    SMBIOS_OPTS=(-smbios "type=1,manufacturer=${OVERWRITE_HOST},product=${OVERWRITE_HOST}")
fi



if [ -n "$BANNER" ]; then
    echo -e "${BANNER}"
fi

echo "Starting AeroVM"

exec qemu-system-x86_64 \
    "${QEMU_ACCEL[@]}" \
    -m "${VM_RAM_MB}M" \
    -smp "${VM_CPU_CORES}" \
    -drive "file=${DISK_IMAGE},format=qcow2,if=virtio,cache=${CACHE_MODE},aio=${AIO_MODE}" \
    "${NETDEV_OPTS[@]}" \
    "${DISPLAY_SECRET_OPTS[@]}" \
    "${DISPLAY_OPTS[@]}" \
    "${INPUT_OPTS[@]}" \
    "${AUDIO_OPTS[@]}" \
    "${VIRTFS_OPTS[@]}" \
    "${UEFI_OPTS[@]}" \
    "${SMBIOS_OPTS[@]}" \
    "${CDROM_OPTS[@]}" \
    -device virtio-balloon \
    -device virtio-rng-pci \
    -rtc base=utc,driftfix=slew \
    -boot "order=${BOOT_ORDER}"