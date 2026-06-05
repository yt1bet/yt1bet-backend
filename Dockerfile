FROM python:3.11-slim

# Install Node.js
RUN apt-get update && apt-get install -y curl ffmpeg && \
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean

# Install yt-dlp latest
RUN pip install -U yt-dlp

# Set working directory
WORKDIR /app

# Copy files
COPY package.json .
COPY server.js .

# Install node deps
RUN npm install

# Start server
CMD ["node", "server.js"]
