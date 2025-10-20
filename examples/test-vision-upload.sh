#!/bin/bash

# Test script for the new Claude Vision PDF processing endpoint
# Usage: ./test-vision-upload.sh <path-to-pdf>

if [ -z "$1" ]; then
  echo "Usage: ./test-vision-upload.sh <path-to-pdf>"
  echo "Example: ./test-vision-upload.sh ./sample.pdf"
  exit 1
fi

PDF_FILE="$1"

if [ ! -f "$PDF_FILE" ]; then
  echo "Error: PDF file not found: $PDF_FILE"
  exit 1
fi

echo "📤 Uploading PDF: $PDF_FILE"
echo "🖼️  Converting to PNG images with Ghostscript..."
echo "🤖 Sending images to Claude for analysis..."
echo ""

# Make the API call
# Add uploadToS3=true to also upload the generated images to S3
curl -X POST http://localhost:8080/v1/ocr/upload-and-process-vision \
  -F "pdf=@${PDF_FILE}" \
  -F "uploadToS3=false" \
  | jq '.'

echo ""
echo "✅ Processing complete!"
