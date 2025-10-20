# Troubleshooting Guide - Claude Vision Endpoint

## Common Errors and Solutions

### 1. ImageMagick Version Warning/Error

**Error:**
```
WARNING: The convert command is deprecated in IMv7, use "magick" instead of "convert"
convert: no decode delegate for this image format `90' @ error/constitute.c/ReadImage/746.
```

**Cause:**
- ImageMagick v7 changed command syntax from `convert` to `magick`
- The `-quality 90` flag was being interpreted as a filename in v6

**Solution Applied:**
The code now automatically detects ImageMagick version and uses the correct syntax:
- **v7**: `magick image.png -resize 1800x1800> -quality 90 output.png`
- **v6**: `convert image.png -resize 1800x1800> output.png`

**Check your version:**
```bash
# ImageMagick v7
magick --version

# ImageMagick v6
convert --version
```

### 2. Image Dimensions Exceed Limit

**Error:**
```
Error 400: At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels
```

**Cause:**
- Claude API has a 2000px maximum dimension limit when sending multiple images
- High DPI (300) PDFs can generate images larger than this

**Solution Applied:**
All images are now automatically resized to 1800x1800px max (conservative limit):
- Only resizes if image exceeds 1800px
- Maintains aspect ratio
- Uses high-quality resizing algorithm

**To adjust resolution:**
Set environment variable to lower DPI:
```bash
GS_IMAGE_RESOLUTION=150  # Lower resolution = smaller images
```

### 3. Request Too Large (413)

**Error:**
```
Error 413: Request exceeds the maximum size
```

**Cause:**
- Total base64-encoded image size exceeds ~10MB API limit
- Multiple high-resolution images add up quickly

**Solution Applied:**
Automatic batching system:
1. Calculates total size of all images
2. If > 8MB, splits into batches
3. Processes each batch with 2-second delays
4. If batch still fails, processes images individually

**How batching works:**
```
10 images (12MB total)
  ↓
Split into batches:
  - Batch 1: 5 images (7MB)
  - Batch 2: 5 images (5MB)
  ↓
Process separately → combine results
```

### 4. Directory Cleanup Error

**Error:**
```
ENOTEMPTY: directory not empty, rmdir 'temp/ocr/gs_images_...'
```

**Cause:**
- Some files weren't deleted before attempting to remove directory
- Race condition or file system delay

**Solution Applied:**
Robust cleanup with error handling:
1. Deletes all tracked image files (original + resized)
2. Scans directory for remaining files
3. Deletes any remaining files
4. Finally removes directory
5. All steps wrapped in try-catch to prevent crashes

### 5. Missing Dependencies

**Error:**
```
Command not found: gs
Command not found: convert / magick
```

**Solution:**
Install required tools:

**macOS:**
```bash
brew install ghostscript imagemagick
```

**Ubuntu/Debian:**
```bash
sudo apt-get install ghostscript imagemagick
```

**Verify installation:**
```bash
gs --version
magick --version  # or convert --version for v6
```

## Configuration Tips

### Optimize for Speed

For faster processing (lower quality):
```bash
# Lower DPI
GS_IMAGE_RESOLUTION=150

# Lower Ghostscript quality
GS_QUALITY=screen  # screen < ebook < printer < prepress
```

### Optimize for Quality

For better extraction (slower):
```bash
# Higher DPI (but may trigger resizing)
GS_IMAGE_RESOLUTION=300

# Higher Ghostscript quality
GS_QUALITY=printer
```

### Balance Speed and Quality

Recommended settings:
```bash
GS_IMAGE_RESOLUTION=200  # Good balance
GS_QUALITY=ebook        # Default, good balance
```

## Debugging

### Enable Verbose Logging

The endpoint already includes detailed logging. Watch the console output:
```
📤 Received upload: document.pdf (1234567 bytes)
🔧 Optimizing PDF with Ghostscript...
✅ PDF optimized
🖼️ Converting PDF to PNG images at 300 DPI...
✅ Ghostscript image conversion completed in 1234ms
📸 Generated 10 images from PDF
📐 Resizing images to meet Claude's dimension requirements...
  ✓ output_001.png: 2345KB → 567KB
  ✓ output_002.png: 2234KB → 545KB
  ...
✅ Resized 10 images
🤖 Sending images to Claude for analysis...
📸 Total image data: 5.67 MB across 10 images
✅ Claude vision analysis successful: extracted 15 contacts from 10 images
💾 Saving 15 contacts to PostgreSQL...
✅ Saved 15 contacts to PostgreSQL
```

### Check Intermediate Files

If processing fails, check the temp directory:
```bash
ls -lh temp/ocr/gs_images_*
```

You should see:
- `output_001.png` (original)
- `output_001_resized.png` (resized)
- etc.

### Test Individual Components

**Test Ghostscript:**
```bash
gs -o test_%03d.png -sDEVICE=png16m -r300 your.pdf
```

**Test ImageMagick:**
```bash
# v7
magick test_001.png -resize 1800x1800> resized.png

# v6
convert test_001.png -resize 1800x1800> resized.png
```

**Check image dimensions:**
```bash
# v7
magick identify test_001.png

# v6
identify test_001.png
```

## Performance Issues

### Slow Processing

**Symptoms:**
- Takes several minutes per PDF
- Multiple batches being processed

**Solutions:**
1. Lower the DPI:
   ```bash
   GS_IMAGE_RESOLUTION=150
   ```

2. Check if batching is triggering:
   - Watch logs for "Split into X batches"
   - Lower DPI to reduce image sizes

3. Check network latency:
   - Claude API calls require good internet connection
   - Each batch adds 2-second delay

### Memory Issues

**Symptoms:**
- Process crashes with out-of-memory errors
- System becomes slow during processing

**Solutions:**
1. Process smaller PDFs (< 50 pages)
2. Lower DPI to reduce memory usage
3. Increase Node.js memory limit:
   ```bash
   NODE_OPTIONS=--max-old-space-size=4096 npm start
   ```

## Error Response Examples

### Successful Response
```json
{
  "success": true,
  "file": "document.pdf",
  "method": "ghostscript-claude-vision",
  "imagesGenerated": 10,
  "resolution": "300 DPI",
  "contactCount": 15,
  "contacts": [...]
}
```

### Error Response
```json
{
  "success": false,
  "message": "Processing failed: <error details>",
  "error": "<stack trace>"
}
```

## Getting Help

If issues persist:

1. **Check logs** - Look for specific error messages
2. **Verify dependencies** - Ensure Ghostscript and ImageMagick are installed
3. **Test with small PDF** - Try a 1-2 page PDF first
4. **Check disk space** - Temp directory needs space for images
5. **Review environment variables** - Ensure all required vars are set

## Common Fixes Summary

| Issue | Quick Fix |
|-------|-----------|
| ImageMagick v7 warning | Fixed automatically - detects version |
| Image too large (2000px) | Fixed automatically - resizes to 1800px |
| Request too large (413) | Fixed automatically - batches images |
| Directory cleanup error | Fixed automatically - robust cleanup |
| Slow processing | Lower DPI: `GS_IMAGE_RESOLUTION=150` |
| Missing dependencies | Install: `brew install ghostscript imagemagick` |
