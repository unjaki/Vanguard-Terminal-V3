# Use Node 20 as the base
FROM node:20-slim

# Create app directory
WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install dependencies (production only)
RUN npm install --only=production

# Copy app source
COPY . .

# The app listens on port 3000
EXPOSE 3000

# Start command
CMD [ "node", "server.js" ]
