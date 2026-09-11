#!/bin/bash

#modifica nel file .env il modello

docker compose down &&
docker compose build --no-cache &&
docker compose up -d
