const { Buffer } = require("node:buffer");
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const DATA_URL =
  "https://hypixel-skyblock.fandom.com/api.php?action=query&prop=revisions&titles=Module:Pet/Data&rvprop=content&format=json&origin=*";
const LOCAL_DATA_FILE = "Data.json";
const REPO_URL =
  "https://github.com/NotEnoughUpdates/NotEnoughUpdates-REPO.git";
const LOCAL_REPO_PATH = path.resolve(__dirname, "NEU-repo");
const OUTPUT_BASE = path.resolve(__dirname, "data/pets");

function cleanText(text) {
  if (!text) return "";
  return String(text)
    .replace(/§./g, "")
    .replace(/_/g, " ")
    .toUpperCase()
    .trim();
}

async function downloadFandomData() {
  console.log("Downloading latest Pet/Data from Fandom...");
  fs.mkdirSync(path.dirname(OUTPUT_BASE), { recursive: true });
  try {
    const response = await fetch(DATA_URL, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: "https://hypixel-skyblock.fandom.com/",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const data = await response.json();
    const pages = data?.query?.pages || {};
    let luaContent = "";
    for (const pageId in pages) {
      const revisions = pages[pageId].revisions || [];
      if (revisions.length > 0) {
        luaContent = revisions[0]["*"] || "";
        break;
      }
    }
    if (!luaContent) throw new Error("Could not find lua content in JSON");
    fs.writeFileSync(LOCAL_DATA_FILE, luaContent, "utf-8");
    console.log("Downloaded Fandom Data successfully.");
  } catch (e) {
    console.log(`Failed to download Fandom Data: ${e.message}`);
    const fallbackPaths = [
      path.resolve(__dirname, "../data.json"),
      path.resolve(__dirname, "../public/data.json"),
      path.resolve(__dirname, "../src/data.json"),
    ];
    let fallbackPath = fallbackPaths.find((p) => fs.existsSync(p));
    if (!fs.existsSync(LOCAL_DATA_FILE)) {
      if (fallbackPath) {
        console.log(
          `Falling back to cached ${path.basename(fallbackPath)} from frontend project.`,
        );
        fs.copyFileSync(fallbackPath, LOCAL_DATA_FILE);
      } else {
        console.log(
          "FAILED: Fandom blocked request and no local Data.json fallback exists.",
        );
        console.log("Please manually download:");
        console.log(`   ${DATA_URL}`);
        console.log(
          `   and save it as '${LOCAL_DATA_FILE}' in this directory.`,
        );
      }
    }
  }
}

function syncNeuRepo() {
  if (fs.existsSync(LOCAL_REPO_PATH)) {
    console.log("Updating existing NEU-repo...");
    try {
      execSync("git pull", { cwd: LOCAL_REPO_PATH, stdio: "pipe" });
    } catch {
      console.log("Git update skipped. Using local repo.");
    }
  } else {
    console.log("Cloning NEU-repo...");
    execSync(`git clone --depth 1 ${REPO_URL} "${LOCAL_REPO_PATH}"`, {
      stdio: "inherit",
    });
  }
}

function getPetInfoFromLua() {
  if (!fs.existsSync(LOCAL_DATA_FILE)) {
    console.log("CRITICAL: Data.json not found. Cannot build pet mapping!");
    return {};
  }
  const petMap = {};
  const content = fs.readFileSync(LOCAL_DATA_FILE, "utf-8");
  const pattern = /\[["']([^"']+)["']\]\s*=\s*\{\s*id\s*=\s*["']([^"']+)["']/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    const folderName = match[1];
    const idString = match[2];
    const ids = idString.split(",").map((i) => i.trim().toUpperCase());
    petMap[folderName] = { ids, cleanName: cleanText(folderName) };
  }
  console.log(`Extracted ${Object.keys(petMap).length} pet entries.`);
  return petMap;
}

function extractTextureUrl(data) {
  try {
    const nbt = data.nbttag || "";
    const match = nbt.match(/Value\s*:\s*"([^"]+)"/);
    if (match) {
      const decoded = JSON.parse(
        Buffer.from(match[1], "base64").toString("utf-8"),
      );
      return decoded.textures.SKIN.url;
    }
  } catch {
    return null;
  }
  return null;
}

function getAllFiles(dirPath, arrayOfFiles) {
  const files = fs.readdirSync(dirPath);
  arrayOfFiles = arrayOfFiles || [];
  files.forEach(function (file) {
    const filePath = path.join(dirPath, file);
    if (fs.statSync(filePath).isDirectory()) {
      arrayOfFiles = getAllFiles(filePath, arrayOfFiles);
    } else if (file.endsWith(".json")) {
      arrayOfFiles.push(filePath);
    }
  });
  return arrayOfFiles;
}

function toTitleCase(str) {
  return str.replace(
    /\w\S*/g,
    (txt) => txt.charAt(0).toUpperCase() + txt.substring(1).toLowerCase(),
  );
}

function buildPetStructure() {
  const petMap = getPetInfoFromLua();
  if (Object.keys(petMap).length === 0) return;
  const allCleanNames = new Set(Object.values(petMap).map((p) => p.cleanName));
  const itemsPath = path.join(LOCAL_REPO_PATH, "items");
  if (fs.existsSync(OUTPUT_BASE)) {
    fs.rmSync(OUTPUT_BASE, { recursive: true, force: true });
  }
  fs.mkdirSync(OUTPUT_BASE, { recursive: true });
  console.log("🚀 Copying animatedskulls.json and custom_skins.json...");
  const animatedSkullsSrc = path.join(
    LOCAL_REPO_PATH,
    "constants",
    "animatedskulls.json",
  );
  if (fs.existsSync(animatedSkullsSrc)) {
    fs.copyFileSync(
      animatedSkullsSrc,
      path.join(path.dirname(OUTPUT_BASE), "animatedskulls.json"),
    );
  } else {
    console.log("Warning: animatedskulls.json not found in NEU clone.");
  }
  console.log("Scanning NEU-repo for multi-ID assets...");
  let allFiles = [];
  try {
    allFiles = getAllFiles(itemsPath);
  } catch (e) {
    console.log("Failed to read NEU-repo items", e);
  }
  for (const [folderName, info] of Object.entries(petMap)) {
    const petFolder = path.join(
      OUTPUT_BASE,
      toTitleCase(folderName.replace(/ /g, "_")),
    );
    const defaultsDir = path.join(petFolder, "defaults");
    const skinsDir = path.join(petFolder, "skins");
    const targetIds = info.ids;
    const cleanSearchName = info.cleanName;
    for (const filePath of allFiles) {
      const fileName = path.basename(filePath);
      const fname = fileName.toUpperCase();
      if (fname.includes(";")) {
        const baseId = fname.split(";")[0];
        if (targetIds.includes(baseId)) {
          fs.mkdirSync(defaultsDir, { recursive: true });
          fs.copyFileSync(
            filePath,
            path.join(defaultsDir, fileName.toLowerCase()),
          );
        }
        continue;
      }
      if (fname.startsWith("PET_SKIN_")) {
        try {
          const fileData = fs.readFileSync(filePath, "utf-8");
          const data = JSON.parse(fileData);
          const lore = data.lore || [];
          const displayName = data.displayname || "";
          const StringConcat = lore.join(" ") + displayName;
          const loreBlob = cleanText(StringConcat);
          let matched = false;
          const appliedToMatch = loreBlob.match(
            /THIS SKIN CAN (?:ONLY )?BE APPLIED TO (.*?) PETS/,
          );

          if (appliedToMatch) {
            let applicablePetsStr = appliedToMatch[1].replace(/ AND /g, ",");
            const applicablePets = applicablePetsStr
              .split(",")
              .map((p) => p.trim())
              .filter((p) => p.length > 0);

            for (const p of applicablePets) {
              if (allCleanNames.has(p)) {
                if (p === cleanSearchName) {
                  matched = true;
                  break;
                }
              } else {
                if (
                  p === cleanSearchName ||
                  p.endsWith(" " + cleanSearchName)
                ) {
                  matched = true;
                  break;
                }
              }
            }
          } else {
            matched =
              targetIds.some((pid) => loreBlob.includes(pid)) ||
              loreBlob.includes(cleanSearchName);
          }

          if (matched) {
            fs.mkdirSync(skinsDir, { recursive: true });
            const newSkinPath = path.join(skinsDir, fileName.toLowerCase());
            fs.copyFileSync(filePath, newSkinPath);
            const texUrl = extractTextureUrl(data);
            if (texUrl) {
              fs.writeFileSync(newSkinPath.replace(".json", ".url"), texUrl);
            }
          }
        } catch {
          continue;
        }
      }
    }
  }
  console.log(`\nFINISHED! Check the '${OUTPUT_BASE}' directory.`);
}

async function main() {
  await downloadFandomData();
  syncNeuRepo();
  buildPetStructure();
}

main();
