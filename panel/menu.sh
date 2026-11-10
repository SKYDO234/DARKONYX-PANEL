#!/usr/bin/env bash
# ==============================================================================
#   🎮 DARKONYX PANEL — management script
#   Zero-config install · start/stop · status · users · update · uninstall
# ==============================================================================
set -o pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'
PURPLE='\033[0;35m'; CYAN='\033[0;36m'; WHITE='\033[1;37m'; GRAY='\033[0;90m'
BOLD='\033[1m'; NC='\033[0m'

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR" || exit 1
APP_NAME="darkonyx"

banner() {
  echo ""
  echo -e "${PURPLE}  ██████╗  █████╗ ██████╗ ██╗  ██╗ ██████╗ ███╗   ██╗██╗   ██╗██╗  ██╗${NC}"
  echo -e "${PURPLE}  ██╔══██╗██╔══██╗██╔══██╗██║ ██╔╝██╔═══██╗████╗  ██║╚██╗ ██╔╝╚██╗██╔╝${NC}"
  echo -e "${PURPLE}  ██║  ██║███████║██████╔╝█████╔╝ ██║   ██║██╔██╗ ██║ ╚████╔╝  ╚███╔╝ ${NC}"
  echo -e "${PURPLE}  ██║  ██║██╔══██║██╔══██╗██╔═██╗ ██║   ██║██║╚██╗██║  ╚██╔╝   ██╔██╗ ${NC}"
  echo -e "${PURPLE}  ██████╔╝██║  ██║██║  ██║██║  ██╗╚██████╔╝██║ ╚████║   ██║   ██╔╝ ██╗${NC}"
  echo -e "${PURPLE}  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═══╝   ╚═╝   ╚═╝  ╚═╝${NC}"
  echo -e "  ${GRAY}obsidian-grade Minecraft server control${NC}   ${CYAN}Panel${NC} ${WHITE}3001${NC} · ${CYAN}Daemon${NC} ${WHITE}3003${NC} · ${CYAN}SFTP${NC} ${WHITE}3004${NC}"
  echo ""
}

need_node() {
  if ! command -v node >/dev/null; then
    echo -e "${RED}Node.js is required (>= 22.5).${NC}"
    echo -e "${YELLOW}Install it, then re-run: ./menu.sh${NC}"
    exit 1
  fi
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$major" -lt 22 ]; then
    echo -e "${YELLOW}Warning:${NC} Node $major detected. DARKONYX embeds SQLite via node:sqlite and needs Node >= 22.5."
    echo -e "         Install MariaDB + set ${CYAN}DB_DRIVER=mysql${NC} to run on older Node versions."
  fi
}

install_panel() {
  banner
  need_node
  echo -e "${CYAN}▶ Installing dependencies…${NC}"
  npm install --no-audit --no-fund || { echo -e "${RED}npm install failed${NC}"; exit 1; }
  echo -e "${CYAN}▶ Preparing runtime directories…${NC}"
  mkdir -p data storage/servers storage/backups public/uploads/branding
  echo -e "${CYAN}▶ Initialising database + admin user…${NC}"
  node bin/setup.js --admin-user admin --admin-pass admin
  echo ""
  echo -e "${GREEN}✔ DARKONYX PANEL installed.${NC}"
  echo -e "   Start it with: ${WHITE}./menu.sh start${NC}   (or ${WHITE}npm start${NC})"
  echo -e "   Panel URL:     ${WHITE}http://localhost:3001${NC}"
  echo -e "   Default login: ${WHITE}admin / admin${NC} — change it immediately."
}

start_panel() {
  banner
  if command -v pm2 >/dev/null; then
    pm2 describe "$APP_NAME" >/dev/null 2>&1 \
      && pm2 restart "$APP_NAME" --update-env \
      || pm2 start ecosystem.config.js
    pm2 save >/dev/null 2>&1
    echo -e "${GREEN}✔ Running under PM2 as '${APP_NAME}'${NC} — logs: pm2 logs ${APP_NAME}"
  else
    echo -e "${YELLOW}PM2 not found — starting in the foreground (Ctrl+C to stop).${NC}"
    node src/index.js
  fi
}

stop_panel() {
  if command -v pm2 >/dev/null && pm2 describe "$APP_NAME" >/dev/null 2>&1; then
    pm2 stop "$APP_NAME" && echo -e "${GREEN}✔ Stopped${NC}"
  else
    pkill -f "node src/index.js" && echo -e "${GREEN}✔ Stopped${NC}" || echo -e "${YELLOW}Not running${NC}"
  fi
}

status_panel() {
  banner
  echo -e "${BOLD}Runtime${NC}"
  echo -e "  Node:    $(node -v 2>/dev/null || echo 'missing')"
  echo -e "  PM2:     $(command -v pm2 >/dev/null && pm2 pid "$APP_NAME" 2>/dev/null | head -1 || echo 'n/a')"
  echo -e "  DB mode: $(grep -E '^DB_DRIVER=' .env 2>/dev/null | cut -d= -f2 || echo 'sqlite (default)')"
  echo ""
  echo -e "${BOLD}Listening ports${NC}"
  for p in 3001 3003 3004; do
    if command -v ss >/dev/null; then
      ss -ltn 2>/dev/null | grep -q ":$p " && echo -e "  ${GREEN}● $p${NC}" || echo -e "  ${GRAY}○ $p${NC}"
    else
      (echo >/dev/tcp/127.0.0.1/$p) >/dev/null 2>&1 && echo -e "  ${GREEN}● $p${NC}" || echo -e "  ${GRAY}○ $p${NC}"
    fi
  done
  echo ""
  node bin/migrate.js >/dev/null 2>&1 && echo -e "${GREEN}✔ Database reachable${NC}" || echo -e "${YELLOW}⚠ Database check failed${NC}"
}

create_user() {
  node bin/createuser.js
}

update_panel() {
  banner
  echo -e "${CYAN}▶ Backing up data directory…${NC}"
  tar -czf "backup-darkonyx-$(date +%Y%m%d-%H%M%S).tar.gz" data storage .env 2>/dev/null || true
  echo -e "${CYAN}▶ Pulling latest changes…${NC}"
  git pull --rebase || echo -e "${YELLOW}No git remote — skipping pull${NC}"
  npm install --no-audit --no-fund
  node bin/migrate.js
  command -v pm2 >/dev/null && pm2 restart "$APP_NAME" --update-env
  echo -e "${GREEN}✔ Update complete${NC}"
}

uninstall_panel() {
  read -r -p "Remove DARKONYX PANEL (data + servers kept)? [y/N] " reply
  case "$reply" in
    [yY]*)
      stop_panel
      command -v pm2 >/dev/null && pm2 delete "$APP_NAME" >/dev/null 2>&1
      rm -rf node_modules
      echo -e "${GREEN}✔ Removed application files. Your data/ and storage/ folders were kept.${NC}"
      ;;
    *) echo "Cancelled." ;;
  esac
}

menu() {
  while true; do
    banner
    echo -e "  ${WHITE}1)${NC} Install / repair        ${WHITE}2)${NC} Start"
    echo -e "  ${WHITE}3)${NC} Stop                   ${WHITE}4)${NC} Status"
    echo -e "  ${WHITE}5)${NC} Create user            ${WHITE}6)${NC} Update panel"
    echo -e "  ${WHITE}7)${NC} Foreground run         ${WHITE}8)${NC} Uninstall"
    echo -e "  ${WHITE}0)${NC} Exit"
    echo ""
    read -r -p "  Select › " choice
    case "$choice" in
      1) install_panel ;;
      2) start_panel ;;
      3) stop_panel ;;
      4) status_panel ;;
      5) create_user ;;
      6) update_panel ;;
      7) node src/index.js ;;
      8) uninstall_panel ;;
      0|q|Q) exit 0 ;;
      *) echo -e "${YELLOW}Invalid option${NC}" ;;
    esac
    echo ""
    read -r -n 1 -s -p "Press any key to continue…"
  done
}

case "${1:-}" in
  install) install_panel ;;
  start) start_panel ;;
  stop) stop_panel ;;
  restart) stop_panel; start_panel ;;
  status) status_panel ;;
  user|createuser) create_user ;;
  update) update_panel ;;
  run) need_node; node src/index.js ;;
  uninstall) uninstall_panel ;;
  "") menu ;;
  *) echo "Usage: ./menu.sh [install|start|stop|restart|status|user|update|run|uninstall]"; exit 1 ;;
esac
