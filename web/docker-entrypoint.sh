#!/bin/sh
set -e

# Executed automatically by the official nginx image entrypoint through /docker-entrypoint.d/*.sh before nginx starts.
# Generate runtime config.js from environment variables. Each analytics provider has an independent variable;
# unset providers remain disabled, load no scripts, and send no external requests. Multiple providers may be enabled together.

# GA4 and Baidu IDs contain only letters, numbers, and hyphens. Remove other characters
# so quotes and similar values cannot break the JavaScript strings in config.js as a defense-in-depth measure.
sanitize_id() {
    printf '%s' "$1" | tr -cd 'A-Za-z0-9-'
}

GA4_ID=$(sanitize_id "${ANALYTICS_GA4_ID:-}")
BAIDU_ID=$(sanitize_id "${ANALYTICS_BAIDU_ID:-}")
CANVAS_AGENT_URL=$(printf '%s' "${CANVAS_AGENT_URL:-}" | tr -cd 'A-Za-z0-9:/._-')
CANVAS_AGENT_MANAGED=$(printf '%s' "${CANVAS_AGENT_MANAGED:-}" | tr '[:upper:]' '[:lower:]')
if [ "$CANVAS_AGENT_MANAGED" = "true" ] || [ "$CANVAS_AGENT_MANAGED" = "1" ]; then
    CANVAS_AGENT_MANAGED=true
else
    CANVAS_AGENT_MANAGED=false
fi

cat > /usr/share/nginx/html/config.js <<EOF
window.__RUNTIME_CONFIG__ = {
  ANALYTICS_GA4_ID: "${GA4_ID}",
  ANALYTICS_BAIDU_ID: "${BAIDU_ID}",
  CANVAS_AGENT_URL: "${CANVAS_AGENT_URL}",
  CANVAS_AGENT_MANAGED: ${CANVAS_AGENT_MANAGED}
};
EOF

# Optional site-wide password protection. Credentials are supplied only at
# runtime and the generated bcrypt file never enters the image or frontend.
AUTH_USER=${CANVAS_AUTH_USER:-}
AUTH_PASSWORD=${CANVAS_AUTH_PASSWORD:-}
AUTH_CONFIG=/etc/nginx/canvas-auth.conf

if [ -n "$AUTH_USER" ] && [ -n "$AUTH_PASSWORD" ]; then
    case "$AUTH_USER" in
        *[!A-Za-z0-9._-]*)
            echo "CANVAS_AUTH_USER may contain only letters, numbers, dot, underscore, and hyphen." >&2
            exit 1
            ;;
    esac

    umask 077
    printf '%s\n' "$AUTH_PASSWORD" | htpasswd -i -c -B /etc/nginx/.htpasswd "$AUTH_USER" >/dev/null
    cat > "$AUTH_CONFIG" <<'EOF'
auth_basic "Infinite Canvas";
auth_basic_user_file /etc/nginx/.htpasswd;
EOF
elif [ -n "$AUTH_USER" ] || [ -n "$AUTH_PASSWORD" ]; then
    echo "CANVAS_AUTH_USER and CANVAS_AUTH_PASSWORD must be configured together." >&2
    exit 1
else
    printf '%s\n' '# Site authentication disabled.' > "$AUTH_CONFIG"
fi
