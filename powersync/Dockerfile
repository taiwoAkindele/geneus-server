# The PowerSync service with this repo's configuration built in, so a host that
# cannot mount files (Render) still deploys the config committed here; a
# regenerated sync-config.yaml ships with the next deploy. docker-compose.yml
# builds this too and mounts ./powersync over /config, so development edits
# apply without a rebuild. The version is pinned here and nowhere else.
FROM journeyapps/powersync-service:1.26.0

COPY service.yaml sync-config.yaml /config/
ENV POWERSYNC_CONFIG_PATH=/config/service.yaml

CMD ["start", "-r", "unified"]
