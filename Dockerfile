FROM node:20-slim

# Install Chromium and system libraries required to run a headless browser engine
RUN apt-get update && apt-get install -y \
    chromium \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libasound2 \
    libxshmfence1 \
    libxss1 \
    && rm -rf /var/lib/apt/lists/*

# Establish application directory structure
WORKDIR /app

# Copy dependency mappings first to optimize build caching layers
COPY package*.json ./
RUN npm install

# Copy source assets across the build scope
COPY . .

# Set clear system execution permissions for node container control
RUN chmod -R 777 /app

# Hugging Face containers mandate binding onto port 7860
EXPOSE 7860

CMD ["npm", "start"]