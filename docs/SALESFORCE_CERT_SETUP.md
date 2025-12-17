# Salesforce Certificate Setup Guide

## Security Best Practices

SSL certificates and private keys should **NEVER** be stored in the project directory or committed to git.

## Local Development Setup

### 1. Create Secure Certificate Directory
```bash
# Create directory outside project root
mkdir -p ~/certs/salesforce

# Move certificate files
mv certificate.crt ~/certs/salesforce/
mv private.pem ~/certs/salesforce/

# Set secure permissions
chmod 600 ~/certs/salesforce/private.pem  # Private key - owner read/write only
chmod 644 ~/certs/salesforce/certificate.crt  # Certificate - owner read/write, others read
```

### 2. Update .env File
Add these lines to your `.env` file:
```bash
# Salesforce Integration
SALESFORCE_CERT_PATH=/Users/matthewsullivan/certs/salesforce/certificate.crt
SALESFORCE_KEY_PATH=/Users/matthewsullivan/certs/salesforce/private.pem
SALESFORCE_CLIENT_ID=your_salesforce_client_id
SALESFORCE_USERNAME=your_salesforce_username
SALESFORCE_LOGIN_URL=https://login.salesforce.com
```

## Production Server Setup

### 1. Create Secure Certificate Directory
```bash
# Create directory in secure location
sudo mkdir -p /etc/ssl/private/salesforce

# Upload certificate files (use scp or secure method)
scp certificate.crt user@server:/tmp/
scp private.pem user@server:/tmp/

# Move to secure location
sudo mv /tmp/certificate.crt /etc/ssl/private/salesforce/
sudo mv /tmp/private.pem /etc/ssl/private/salesforce/

# Set ownership (assuming your app runs as 'node' user)
sudo chown node:node /etc/ssl/private/salesforce/*

# Set secure permissions
sudo chmod 600 /etc/ssl/private/salesforce/private.pem
sudo chmod 644 /etc/ssl/private/salesforce/certificate.crt

# Remove temp files
sudo rm -f /tmp/certificate.crt /tmp/private.pem
```

### 2. Update Production .env File
On your production server, update `.env` with:
```bash
# Salesforce Integration
SALESFORCE_CERT_PATH=/etc/ssl/private/salesforce/certificate.crt
SALESFORCE_KEY_PATH=/etc/ssl/private/salesforce/private.pem
SALESFORCE_CLIENT_ID=your_salesforce_client_id
SALESFORCE_USERNAME=your_salesforce_username
SALESFORCE_LOGIN_URL=https://login.salesforce.com
```

## Usage in Code

Access certificate paths via environment variables:

```javascript
const fs = require('fs');

const salesforceConfig = {
  clientId: process.env.SALESFORCE_CLIENT_ID,
  username: process.env.SALESFORCE_USERNAME,
  loginUrl: process.env.SALESFORCE_LOGIN_URL,
  privateKey: fs.readFileSync(process.env.SALESFORCE_KEY_PATH, 'utf8'),
  certificate: fs.readFileSync(process.env.SALESFORCE_CERT_PATH, 'utf8')
};
```

## Security Checklist

- [ ] Certificates stored outside project root
- [ ] Private key has 600 permissions (owner read/write only)
- [ ] Certificate has 644 permissions
- [ ] `.gitignore` excludes `*.pem`, `*.crt`, `*.key` files
- [ ] Environment variables used for paths (not hardcoded)
- [ ] Different paths for development and production
- [ ] Certificates backed up securely (encrypted storage)
- [ ] Certificates have expiration monitoring set up

## Troubleshooting

### Permission Denied Error
```bash
# Check file permissions
ls -la ~/certs/salesforce/
# or on production:
sudo ls -la /etc/ssl/private/salesforce/

# Fix permissions if needed
chmod 600 ~/certs/salesforce/private.pem
```

### File Not Found Error
```bash
# Verify paths in .env match actual file locations
echo $SALESFORCE_CERT_PATH
echo $SALESFORCE_KEY_PATH
```

### Certificate Expiration
Monitor certificate expiration date:
```bash
openssl x509 -in ~/certs/salesforce/certificate.crt -noout -enddate
```

## Important Notes

1. **Never commit certificates to git** - They are now in `.gitignore`
2. **Use different certificates** for development and production if possible
3. **Rotate certificates** before they expire (typically annually)
4. **Backup certificates** securely (encrypted, off-site storage)
5. **Document certificate renewal process** with your team
