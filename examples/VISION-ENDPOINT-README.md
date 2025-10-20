# Claude Vision PDF Processing Endpoint

## Overview

This endpoint processes PDFs by converting them to high-resolution PNG images using Ghostscript, then sends those images to Claude's vision API for contact extraction. This approach is particularly effective for scanned documents or PDFs with complex layouts.

## Endpoint

```
POST /v1/ocr/upload-and-process-vision
```

## How It Works

1. **PDF Upload**: Accepts a PDF file via multipart form data
2. **Ghostscript Optimization**: Optimizes the PDF for better image quality
3. **Image Conversion**: Converts each PDF page to PNG at 300 DPI (configurable)
   - Uses command: `gs -o output_%03d.png -sDEVICE=png16m -r300 gs_resized.pdf`
4. **Image Resizing**: Resizes images to meet Claude's 2000px dimension limit
   - Uses ImageMagick: `convert image.png -resize 1800x1800> -quality 90 image_resized.png`
   - Only resizes if dimensions exceed 1800px (maintains aspect ratio)
5. **Claude Vision Analysis**: Sends all images to Claude for contact extraction
   - Automatically batches if total size > 8MB
   - Falls back to individual processing if needed
6. **PostgreSQL Storage**: Saves extracted contacts to the database
7. **Optional S3 Upload**: Can upload generated images to S3 for archival

## Request Format

### Headers
- `Content-Type: multipart/form-data`

### Form Data
- `pdf` (required): The PDF file to process
- `uploadToS3` (optional): Set to `true` to upload generated images to S3 (default: false)

## cURL Example

```bash
curl -X POST http://localhost:8080/v1/ocr/upload-and-process-vision \
  -F "pdf=@/path/to/document.pdf" \
  -F "uploadToS3=false"
```

## Response Format

```json
{
  "success": true,
  "file": "document.pdf",
  "method": "ghostscript-claude-vision",
  "imagesGenerated": 5,
  "resolution": "300 DPI",
  "gsTime": 1234,
  "claudeTime": 5678,
  "contactCount": 12,
  "contacts": [
    {
      "name": "John Doe",
      "title": "Operations Manager",
      "company": "ABC Energy Corp",
      "phone": "555-123-4567",
      "email": "john.doe@abc-energy.com",
      "address": "123 Main St, Houston, TX 77002",
      "source_file": "document.pdf",
      "extraction_method": "ghostscript-claude-vision"
    }
    // ... more contacts
  ],
  "s3Keys": null,
  "processingTimestamp": "2025-10-17T12:34:56.789Z"
}
```

## Configuration

Environment variables to control behavior:

```bash
# Image resolution for Ghostscript conversion (default: 300)
GS_IMAGE_RESOLUTION=300

# Temporary directory for processing (default: ./temp/ocr)
OCR_TEMP_DIR=./temp/ocr

# Claude API configuration
ANTHROPIC_API_KEY=your_api_key_here

# S3 configuration (for optional image upload)
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
```

## Advantages Over Text-Based OCR

1. **Better Layout Preservation**: Claude can see the visual structure of tables and forms
2. **Handwriting Support**: Can extract information from handwritten documents
3. **Complex Layouts**: Better handling of multi-column layouts, forms, and tables
4. **Image-Based PDFs**: Works with scanned documents that have no text layer

## Limitations

1. **File Size**: Large PDFs with many pages may take longer to process
2. **API Costs**: Uses Claude's vision API which may have different pricing than text-only
3. **Rate Limits**: Subject to Claude API rate limits (includes automatic retry logic)
4. **Memory Usage**: Converting to images requires more memory than text extraction
5. **Image Dimensions**: Images are automatically resized to max 1800x1800px to meet Claude's requirements
6. **Dependencies**: Requires Ghostscript and ImageMagick to be installed

## Comparison with Other Endpoints

| Endpoint | Method | Use Case |
|----------|--------|----------|
| `/v1/ocr/upload-and-process` | Ghostscript + PDF text extraction | Standard PDFs with text layer |
| `/v1/ocr/upload-and-process-vision` | Ghostscript + Claude Vision | Scanned documents, complex layouts |
| `/v1/ocr/process-claude-only` | Direct PDF parsing + Claude | Simple text-based PDFs |

## Testing

Use the provided test script:

```bash
./examples/test-vision-upload.sh /path/to/your/document.pdf
```

Or with the API directly:

```bash
# Without S3 upload
curl -X POST http://localhost:8080/v1/ocr/upload-and-process-vision \
  -F "pdf=@document.pdf" \
  | jq '.'

# With S3 upload
curl -X POST http://localhost:8080/v1/ocr/upload-and-process-vision \
  -F "pdf=@document.pdf" \
  -F "uploadToS3=true" \
  | jq '.'
```

## Error Handling

The endpoint includes:
- **Automatic batch processing**: If images exceed 8MB total, they're split into batches
- **413 Request Too Large handling**: Falls back to processing images individually
- Automatic retry logic for rate limits (429) and overloaded servers (529)
- Exponential backoff for retries
- Comprehensive error messages
- Automatic cleanup of temporary files
- Graceful handling of missing or invalid PDFs

### How Batching Works

When you upload a PDF, the system:

1. Converts all pages to PNG images at specified DPI
2. **Resizes images** if they exceed 1800x1800px (Claude has 2000px limit)
3. Calculates total size of all resized images
4. If total > 8MB:
   - Splits images into batches of max 8MB each
   - Processes each batch separately with 2-second delays
   - Combines results from all batches
5. If a batch gets 413 error:
   - Falls back to processing images one at a time
   - Adds 1-second delays between individual images
6. If dimensions exceed 2000px:
   - Automatically resized to 1800x1800px max (maintains aspect ratio)
   - Uses ImageMagick's high-quality resizing

## Performance Tips

1. **Adjust Resolution**: Lower DPI (e.g., 150-200) for faster processing of simple documents
2. **Batch Processing**: For multiple documents, add delays between requests to avoid rate limits
3. **S3 Upload**: Only enable if you need to archive the generated images
4. **Local Testing**: Use smaller PDFs initially to verify the setup

## Security Considerations

- Files are processed in temporary directories and cleaned up immediately
- Supports file size limits via multer configuration
- Only accepts PDF files (enforced by multer filter)
- Temporary files are deleted even on error conditions
