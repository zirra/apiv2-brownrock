const { execSync } = require('child_process');
const fs = require('fs').promises;
const path = require('path');

class PDFCleaner {
  /**
   * Main cleaning pipeline
   */
  async cleanPDF(inputPath, outputPath) {
    console.log(`Cleaning PDF: ${path.basename(inputPath)}`);
    
    const steps = [];
    let currentPath = inputPath;
    
    // Step 1: Remove overlays/annotations (page numbers, headers, etc)
    const noOverlaysPath = inputPath.replace('.pdf', '_no_overlays.pdf');
    await this.removeOverlays(currentPath, noOverlaysPath);
    steps.push('removed overlays');
    currentPath = noOverlaysPath;
    
    // Step 2: Check if needs OCR
    const needsOCR = await this.isImageBased(currentPath);
    if (needsOCR) {
      console.log('  → PDF is image-based, running OCR...');
      const ocrPath = currentPath.replace('.pdf', '_ocr.pdf');
      await this.ocrPDF(currentPath, ocrPath);
      steps.push('OCR processed');
      currentPath = ocrPath;
    }
    
    // Step 3: Flatten everything (remove all layers, annotations, forms)
    const flattenedPath = currentPath.replace('.pdf', '_flat.pdf');
    await this.flattenPDF(currentPath, flattenedPath);
    steps.push('flattened');
    currentPath = flattenedPath;
    
    // Step 4: Final cleanup and optimization
    await this.finalCleanup(currentPath, outputPath);
    steps.push('optimized');
    
    // Clean up intermediate files
    await this.cleanupTempFiles([noOverlaysPath, ocrPath, flattenedPath], outputPath);
    
    console.log(`  ✓ Complete: ${steps.join(' → ')}`);
    return outputPath;
  }

  /**
   * Remove page numbers, headers, footers, and annotations
   */
  async removeOverlays(inputPath, outputPath) {
    try {
      // Use pdftk to remove annotations and form fields
      execSync(`pdftk "${inputPath}" output "${outputPath}" flatten`, {
        stdio: 'pipe'
      });
    } catch (error) {
      // Fallback: use Ghostscript to strip annotations
      execSync(`gs -o "${outputPath}" \
        -sDEVICE=pdfwrite \
        -dNOPAUSE \
        -dBATCH \
        -dSAFER \
        -dPrinted=false \
        -dNOANNOTS \
        "${inputPath}"`, {
        stdio: 'pipe'
      });
    }
  }

  /**
   * Check if PDF is image-based (needs OCR)
   */
  async isImageBased(pdfPath) {
    try {
      const text = execSync(`pdftotext "${pdfPath}" -`, { encoding: 'utf-8' });
      // If very little text, it's probably images
      return text.trim().length < 100;
    } catch (error) {
      return true;
    }
  }

  /**
   * OCR with settings optimized for low-res scans
   */
  async ocrPDF(inputPath, outputPath) {
    try {
      execSync(`ocrmypdf \
        --force-ocr \
        --deskew \
        --clean \
        --clean-final \
        --rotate-pages \
        --remove-background \
        --oversample 300 \
        --skip-text \
        --redo-ocr \
        --optimize 0 \
        --output-type pdf \
        --jpeg-quality 95 \
        --png-quality 95 \
        "${inputPath}" \
        "${outputPath}"`, {
        stdio: 'pipe',
        maxBuffer: 100 * 1024 * 1024
      });
      return true;
    } catch (error) {
      console.error(`  ⚠ OCR failed: ${error.message}, copying original`);
      await fs.copyFile(inputPath, outputPath);
      return false;
    }
  }

  /**
   * Flatten all layers into single image layer per page
   */
  async flattenPDF(inputPath, outputPath) {
    // Convert to images then back to PDF (ensures everything is flattened)
    const tempDir = path.join(path.dirname(inputPath), 'temp_flatten');
    await fs.mkdir(tempDir, { recursive: true });

    try {
      // Extract at 200 DPI (good balance of quality/size)
      execSync(`pdftoppm -png -r 200 "${inputPath}" "${tempDir}/page"`, {
        stdio: 'pipe'
      });

      // Get all generated images
      const files = await fs.readdir(tempDir);
      const images = files.filter(f => f.endsWith('.png')).sort();
      
      if (images.length === 0) {
        throw new Error('No images generated during flattening');
      }

      // Convert images back to PDF
      const imagePaths = images.map(f => path.join(tempDir, f)).join(' ');
      execSync(`img2pdf ${imagePaths} -o "${outputPath}"`, {
        stdio: 'pipe'
      });

      // Cleanup temp directory
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  /**
   * Final cleanup and optimization
   */
  async finalCleanup(inputPath, outputPath) {
    // Light compression while maintaining quality
    execSync(`gs -o "${outputPath}" \
      -sDEVICE=pdfwrite \
      -dPDFSETTINGS=/printer \
      -dCompatibilityLevel=1.4 \
      -dNOPAUSE \
      -dBATCH \
      -dSAFER \
      "${inputPath}"`, {
      stdio: 'pipe'
    });
  }

  /**
   * Cleanup temporary files
   */
  async cleanupTempFiles(tempFiles, keepFile) {
    for (const file of tempFiles) {
      if (file !== keepFile) {
        try {
          await fs.unlink(file);
        } catch (error) {
          // Ignore cleanup errors
        }
      }
    }
  }

  /**
   * Extract clean images from processed PDF
   */
  async extractCleanImages(pdfPath, outputDir, pageRange = null) {
    await fs.mkdir(outputDir, { recursive: true });

    let cmd = `pdftoppm -png -r 200 "${pdfPath}" "${outputDir}/page"`;
    
    // Add page range if specified (e.g., for postal report pages 51-58)
    if (pageRange) {
      cmd += ` -f ${pageRange.start} -l ${pageRange.end}`;
    }

    execSync(cmd, { stdio: 'pipe' });

    // Return sorted list of image paths
    const files = await fs.readdir(outputDir);
    return files
      .filter(f => f.endsWith('.png'))
      .sort()
      .map(f => path.join(outputDir, f));
  }
}

module.exports = PDFCleaner;