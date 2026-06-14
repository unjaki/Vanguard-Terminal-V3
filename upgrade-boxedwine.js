const axios = require('axios');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');

const ZIP_URL = "https://github.com/danoon2/Boxedwine/releases/download/26R1.0/Boxedwine26R1Web.zip";
const TEMP_ZIP_PATH = path.join(__dirname, "boxedwine_26r1_web.zip");
const EXTRACT_TEMP_DIR = path.join(__dirname, "boxedwine_26r1_extracted");

async function runUpgrade() {
    console.log("=== STARTING BOXEDWINE UPGRADE TO 26R1 ===");
    try {
        console.log(`Downloading Boxedwine 26R1 from: ${ZIP_URL}`);
        const response = await axios({
            method: 'get',
            url: ZIP_URL,
            responseType: 'arraybuffer',
            onDownloadProgress: (progressEvent) => {
                const total = progressEvent.total;
                const current = progressEvent.loaded;
                let percent = total ? Math.round((current / total) * 100) : 0;
                console.log(`Download progress: ${percent}% (${current}/${total || 'unknown'} bytes)`);
            }
        });

        console.log("Saving complete ZIP to temp file...");
        fs.writeFileSync(TEMP_ZIP_PATH, Buffer.from(response.data));
        console.log("Saved ZIP file.");

        console.log("Parsing ZIP archive with AdmZip...");
        const zip = new AdmZip(TEMP_ZIP_PATH);
        
        if (fs.existsSync(EXTRACT_TEMP_DIR)) {
            fs.rmSync(EXTRACT_TEMP_DIR, { recursive: true, force: true });
        }
        fs.mkdirSync(EXTRACT_TEMP_DIR, { recursive: true });

        console.log("Extracting ZIP contents to temporary directory...");
        zip.extractAllTo(EXTRACT_TEMP_DIR, true);
        console.log("Extraction complete!");

        // List extracted files
        const filesList = [];
        function walkDir(dir) {
            const list = fs.readdirSync(dir);
            list.forEach(file => {
                const filePath = path.join(dir, file);
                const stat = fs.statSync(filePath);
                if (stat.isDirectory()) {
                    walkDir(filePath);
                } else {
                    filesList.push(path.relative(EXTRACT_TEMP_DIR, filePath));
                }
            });
        }
        walkDir(EXTRACT_TEMP_DIR);
        console.log("Extracted files list:");
        filesList.forEach(f => console.log(` - ${f}`));

        // Copy files over to target directories
        const mainTargetDir = path.join(__dirname, "public", "boxedwine");
        const v1TargetDir = path.join(__dirname, "public", "boxedwine", "v1");

        // Ensure directories exist
        fs.mkdirSync(mainTargetDir, { recursive: true });
        fs.mkdirSync(v1TargetDir, { recursive: true });

        console.log("Copying core files into /public/boxedwine and /public/boxedwine/v1...");
        for (const relativePath of filesList) {
            const srcPath = path.join(EXTRACT_TEMP_DIR, relativePath);
            const lowerPath = relativePath.toLowerCase();

            // We want to skip copying certain custom files if necessary development has been done on them,
            // or we copy them completely and then verify.
            // Let's copy all of them, except maybe we preserve previous custom configurations or re-edit them.
            // Let's copy files to public/boxedwine/v1 (main emulator target)
            const destPathV1 = path.join(v1TargetDir, relativePath);
            fs.mkdirSync(path.dirname(destPathV1), { recursive: true });
            fs.copyFileSync(srcPath, destPathV1);
            console.log(`Copied to v1: ${relativePath} (${fs.statSync(srcPath).size} bytes)`);

            // Also copy to root public/boxedwine
            const destPathMain = path.join(mainTargetDir, relativePath);
            fs.mkdirSync(path.dirname(destPathMain), { recursive: true });
            fs.copyFileSync(srcPath, destPathMain);
        }

        console.log("=== UPGRADE SCRIPT EXECUTED SUCCESSFULLY ===");
    } catch (error) {
        console.error("Upgrade process failed:", error);
    } finally {
        // Clean up
        try {
            if (fs.existsSync(TEMP_ZIP_PATH)) {
                fs.unlinkSync(TEMP_ZIP_PATH);
            }
            if (fs.existsSync(EXTRACT_TEMP_DIR)) {
                fs.rmSync(EXTRACT_TEMP_DIR, { recursive: true, force: true });
            }
        } catch (e) {
            console.error("Error cleaning up temp files:", e);
        }
    }
}

// Export or run
module.exports = runUpgrade;

if (require.main === module) {
    runUpgrade();
}
