# Claude Vision PDF Processing - Implementation Summary

## Overview

Implemented a new PDF processing endpoint that converts PDF pages to PNG images using Ghostscript, then sends them to Claude's vision API for contact extraction.

## Route

```
POST /v1/ocr/upload-and-process-vision
```

Similar to the existing `/v1/ocr/upload-and-process` route, but uses Claude's vision capabilities instead of text extraction.

## Files Modified/Created

### 1. Controller: [controller/ocr.controller.js](../controller/ocr.controller.js)

**Added Method**: `uploadAndProcessWithClaudeVision()` (lines 1485-1714)

**Processing Pipeline**:
```
PDF Upload
  ↓
Ghostscript Optimization (flatten/compress)
  ↓
Convert to PNG images (300 DPI)
  gs -o output_%03d.png -sDEVICE=png16m -r300
  ↓
Resize images to meet Claude's limits (1800x1800px max)
  convert image.png -resize 1800x1800> -quality 90
  ↓
Send to Claude Vision API (with batching)
  ↓
Extract contacts → Save to PostgreSQL
  ↓
Optional: Upload images to S3
  ↓
Cleanup temporary files
```

**Added Route**: Line 1826
```javascript
app.post('/v1/ocr/upload-and-process-vision',
  upload.single('pdf'),
  (req, res) => ocrController.uploadAndProcessWithClaudeVision(req, res))
```

### 2. Service: [services/ClaudeContactExtractor.cjs](../services/ClaudeContactExtractor.cjs)

**Added Methods**:

1. **`extractContactsFromImages()`** (lines 1214-1287)
   - Main entry point for image-based extraction
   - Handles automatic batching if total size > 8MB
   - Splits images into manageable batches
   - Combines results from all batches

2. **`processSingleImageBatch()`** (lines 1293-1418)
   - Processes a batch of images
   - Builds Claude API request with multiple images
   - Handles 413 errors by falling back to individual processing
   - Includes retry logic for rate limits (429, 529)

**Key Features**:
- **Automatic Batching**: Splits large image sets into 8MB batches
- **Dimension Validation**: Images must be ≤2000px per Claude's requirements
- **Fallback Strategy**: If batch fails with 413, processes images individually
- **Rate Limit Handling**: Exponential backoff for 429/529 errors

### 3. Documentation

Created comprehensive documentation files:

1. **[examples/VISION-ENDPOINT-README.md](VISION-ENDPOINT-README.md)**
   - Complete API documentation
   - Configuration options
   - Error handling strategies
   - Performance tips
   - Comparison with other endpoints

2. **[examples/test-vision-upload.sh](test-vision-upload.sh)**
   - Bash script for testing the endpoint
   - Usage: `./test-vision-upload.sh /path/to/document.pdf`

## Error Handling & Solutions

### Problem 1: 413 Request Too Large
**Error**: Request exceeds maximum size (~10MB limit for base64 images)

**Solution**: Implemented automatic batching
- Monitors total image size
- Splits into 8MB batches if needed
- Processes batches sequentially with delays
- Combines results

### Problem 2: Image Dimensions Too Large
**Error**: `At least one of the image dimensions exceed max allowed size: 2000 pixels`

**Solution**: Added automatic image resizing
- Uses ImageMagick to resize images
- Max dimension: 1800px (conservative limit)
- Maintains aspect ratio
- High quality (90% JPEG quality)
- Only resizes if needed (`-resize 1800x1800>`)

## Configuration

Environment variables:

```bash
# Image resolution for PDF to PNG conversion
GS_IMAGE_RESOLUTION=300

# Ghostscript quality setting
GS_QUALITY=ebook

# Temporary directory for processing
OCR_TEMP_DIR=./temp/ocr

# Claude API
ANTHROPIC_API_KEY=your_api_key

# AWS (for S3 upload)
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your_key
AWS_SECRET_ACCESS_KEY=your_secret
```

## Usage Examples

### Basic Upload

```bash
curl -X POST http://localhost:8080/v1/ocr/upload-and-process-vision \
  -F "pdf=@document.pdf" \
  | jq '.'
```

### With S3 Upload

```bash
curl -X POST http://localhost:8080/v1/ocr/upload-and-process-vision \
  -F "pdf=@document.pdf" \
  -F "uploadToS3=true" \
  | jq '.'
```

### Using Test Script

```bash
chmod +x examples/test-vision-upload.sh
./examples/test-vision-upload.sh /path/to/document.pdf
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
  ],
  "s3Keys": null,
  "processingTimestamp": "2025-10-17T12:34:56.789Z"
}
```

## Processing Flow with Error Handling

```
┌─────────────────────────────────────────────────────────────┐
│ Upload PDF                                                   │
└────────────────────────┬────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│ Ghostscript: Optimize & Convert to PNG                      │
│ gs -o output_%03d.png -sDEVICE=png16m -r300                 │
└────────────────────────┬────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│ ImageMagick: Resize if needed                               │
│ convert -resize 1800x1800> -quality 90                      │
└────────────────────────┬────────────────────────────────────┘
                         ↓
                    Check total size
                         ↓
              ┌──────────┴──────────┐
              │                     │
         < 8MB                  > 8MB
              │                     │
              ↓                     ↓
    ┌─────────────────┐   ┌─────────────────┐
    │ Single Request  │   │ Split to Batches│
    └────────┬────────┘   └────────┬────────┘
             │                     │
             ↓                     ↓
    ┌─────────────────┐   ┌─────────────────┐
    │ Claude API Call │   │ Process Batch 1 │
    └────────┬────────┘   └────────┬────────┘
             │                     │
        Success/413?          Success/413?
             │                     │
          Success            ┌─────┴─────┐
             │               │           │
             ↓          Success        413
    ┌─────────────────┐     │           │
    │ Return Contacts │     ↓           ↓
    └─────────────────┘  Wait 2s    Process
                            │      Individually
                            ↓           │
                    ┌─────────────┐    │
                    │ Process     │    │
                    │ Batch 2...  │←───┘
                    └──────┬──────┘
                           │
                           ↓
                  Combine all results
                           │
                           ↓
                  ┌─────────────────┐
                  │ Save to Postgres│
                  └────────┬────────┘
                           │
                           ↓
                  ┌─────────────────┐
                  │ Cleanup & Return│
                  └─────────────────┘
```

## Advantages Over Text-Based Methods

1. **Visual Understanding**: Claude can see tables, forms, and layout
2. **Handwriting**: Can process handwritten documents
3. **Complex Layouts**: Better handling of multi-column documents
4. **Scanned Documents**: Works with image-based PDFs
5. **No OCR Preprocessing**: Direct image analysis by Claude

## Performance Characteristics

- **Small PDF (1-5 pages)**: ~10-20 seconds
- **Medium PDF (10-20 pages)**: ~30-60 seconds (may batch)
- **Large PDF (50+ pages)**: Several minutes (will batch)

Factors affecting speed:
- Number of pages
- Image resolution (DPI)
- Whether batching is needed
- Network latency to Claude API
- Rate limiting delays

## Dependencies

Required tools (must be installed):
1. **Ghostscript** (`gs`) - PDF to image conversion
2. **ImageMagick** (`convert`) - Image resizing
3. **Node.js** packages (already in package.json):
   - `@anthropic-ai/sdk`
   - `multer`
   - `pdf-parse`

## Testing Checklist

- [x] Single page PDF
- [x] Multi-page PDF (< 8MB total)
- [x] Large PDF requiring batching
- [x] PDF with high-resolution images (> 2000px)
- [x] Error handling for 413 errors
- [x] Error handling for rate limits
- [x] S3 upload functionality
- [x] PostgreSQL contact saving
- [x] Temp file cleanup

## Future Enhancements

Potential improvements:
1. **Parallel Processing**: Process multiple images concurrently
2. **Caching**: Cache processed images to avoid re-processing
3. **Preview Generation**: Generate thumbnail previews
4. **Progress Tracking**: WebSocket updates for long-running jobs
5. **Quality Options**: Allow user to choose between speed vs quality
6. **Format Support**: Add support for other image formats (JPEG, TIFF)
