FROM node:20-slim

WORKDIR /app

# Install git and clean up apt cache to keep the image small
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

RUN npm install

# Copy the rest of your app code
COPY . .

# Hugging Face container networking & SSL compatibility flags
ENV NODE_OPTIONS="--dns-result-order=ipv4first"
ENV NODE_TLS_REJECT_UNAUTHORIZED="0"

# Hugging Face Spaces default port
EXPOSE 7860

# Start the application
CMD ["node", "index.js"]