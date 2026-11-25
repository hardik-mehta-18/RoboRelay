FROM ros:lyrical-ros-base

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && install -d -m 0755 /etc/apt/keyrings \
 && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/roborelay
COPY package.json package-lock.json ./
RUN bash -lc "source /opt/ros/lyrical/setup.bash && npm ci --omit=dev --fetch-retries=5 --fetch-retry-mintimeout=1000"
COPY src ./src
COPY public ./public

ENV PORT=8780
EXPOSE 8780
CMD ["bash", "-lc", "source /opt/ros/lyrical/setup.bash && exec node src/index.js"]
