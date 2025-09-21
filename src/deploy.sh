#!/bin/bash
# deploy.sh - Run this on the LXC container

cd /opt/proxmox-mcp-server

echo "Pulling latest changes..."
git pull

echo "Rebuilding container..."
docker-compose down
docker-compose build --no-cache
docker-compose up -d

echo "Waiting for service to start..."
sleep 3

echo "Checking health..."
curl -s http://localhost:3000/health | jq '.' || echo "Service not ready yet"

echo "Viewing logs..."
docker-compose logs --tail=20