FROM node:20-slim

WORKDIR /app

# Install git and clean up apt cache to keep the image small
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

RUN npm install

# Copy the rest of your app code
COPY . .