const fs = require("fs");
const path = require("path");
const http = require("http");

const DATA_FILE = path.join(__dirname, "data/pets/Data.json");
const PETS_DIR = path.join(__dirname, "data/pets");
const DYES_DIR = path.join(__dirname, "data/dyes");
const SKULL_COSMETICS_DIR = path.join(__dirname, "data/skull_cosmetics");
const ANIMATED_SKULLS_FILE = path.join(__dirname, "data/animatedskulls.json");
const CUSTOM_ANIMATED_FILE = path.join(
  __dirname,
  "data/animated_skins_custom.json",
);

const OUTPUT_REGISTRY = path.join(
  __dirname,
  "dist/public/assets/registry.json",
);
const OUTPUT_DATA_DIR = path.join(__dirname, "dist/public/assets/pet_data");
const OUTPUT_DYE_REGISTRY = path.join(__dirname, "dist/public/assets/dyes.json");
const OUTPUT_HELMET_REGISTRY = path.join(
  __dirname,
  "dist/public/assets/helmets.json",
);
const PUBLIC_DEFAULTS = path.join(
  __dirname,
  "dist/public/assets/pets/defaults",
);
const PUBLIC_SKINS = path.join(__dirname, "dist/public/assets/pets/skins");
const PUBLIC_DYES = path.join(__dirname, "dist/public/assets/dyes/skins");
const PUBLIC_HELMETS = path.join(__dirname, "dist/public/assets/helmets/skins");
const PUBLIC_ANIMATED = path.join(
  __dirname,
  "dist/public/assets/pets/skins/animated_skins",
);

function downloadImage(url, dest) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          return reject(
            new Error(`Failed to fetch ${url}, status: ${res.statusCode}`),
          );
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
        file.on("error", (err) => {
          fs.unlink(dest, () => reject(err));
        });
      })
      .on("error", reject);
  });
}

function getTextureHash(url) {
  if (!url) return null;
  if (!url.includes("minecraft.net/texture/")) return null;
  const parts = url.split("/");
  return parts[parts.length - 1];
}

async function ensureTextureDownloaded(url, destDir, hash, relativePath) {
  if (!url || !hash) return null;
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }
  const destPath = path.join(destDir, `${hash}.png`);

  if (!fs.existsSync(destPath)) {
    console.log(`Downloading texture ${hash}...`);
    try {
      await downloadImage(url, destPath);
    } catch (err) {
      console.error(`Failed to download ${url}:`, err);
      return null;
    }
  }
  return relativePath;
}

let luaparse;
try {
  luaparse = require("luaparse");
} catch (e) {
  luaparse = null;
}

function evaluateNode(node) {
  if (!node) return null;
  switch (node.type) {
    case "StringLiteral":
      if (node.value !== null && node.value !== undefined) return node.value;
      if (node.raw) return node.raw.replace(/['"]/g, "");
      return null;
    case "NumericLiteral":
    case "BooleanLiteral":
      return node.value;
    case "NilLiteral":
      return null;
    case "Identifier":
      return node.name;
    case "TableConstructorExpression": {
      const obj = {};
      let arrayIdx = 1;
      let hasImplicitKeys = false;
      let hasExplicitKeys = false;
      let hasZeroKey = false;

      for (const field of node.fields) {
        if (field.type === "TableKeyString") {
          hasExplicitKeys = true;
          obj[field.key.name] = evaluateNode(field.value);
        } else if (field.type === "TableKey") {
          hasExplicitKeys = true;
          const key = evaluateNode(field.key);
          if (key === 0) hasZeroKey = true;
          obj[key] = evaluateNode(field.value);
        } else if (field.type === "TableValue") {
          hasImplicitKeys = true;
          obj[arrayIdx++] = evaluateNode(field.value);
        }
      }

      if (hasExplicitKeys || hasZeroKey) return obj;
      if (hasImplicitKeys) return Object.values(obj);
      return obj;
    }
    case "UnaryExpression":
      if (node.operator === "-") return -evaluateNode(node.argument);
      return evaluateNode(node.argument);
    default:
      return null;
  }
}

let luaDataCache = null;
function getLuaData() {
  if (luaDataCache !== null) return luaDataCache;
  if (!luaparse || !fs.existsSync(DATA_FILE)) {
    luaDataCache = {};
    return luaDataCache;
  }
  try {
    const content = fs.readFileSync(DATA_FILE, "utf8");
    const ast = luaparse.parse(content);
    const returnStmt = ast.body.find((s) => s.type === "ReturnStatement");
    if (!returnStmt) {
      luaDataCache = {};
      return luaDataCache;
    }
    const tableRaw = evaluateNode(returnStmt.arguments[0]);
    const result = {};
    for (const [displayName, data] of Object.entries(tableRaw || {})) {
      if (data && data.id) {
        result[data.id] = { displayName, ...data };
      }
    }
    luaDataCache = result;
  } catch (e) {
    console.warn("Warning: could not parse Data.json:", e.message);
    luaDataCache = {};
  }
  return luaDataCache;
}

const TIER_TO_LUA = {
  Common: "common",
  Uncommon: "uncommon",
  Rare: "rare",
  Epic: "epic",
  Legendary: "legendary",
  Mythic: "mythic",
  Divine: "divine",
};

function calcVarAtLvl100(luaPetData, tierName, varIdx) {
  if (!luaPetData || !luaPetData.variables) return null;
  const tierKey = TIER_TO_LUA[tierName];
  if (!tierKey) return null;
  const tierVars = luaPetData.variables[tierKey];
  if (!tierVars || tierVars[varIdx] === undefined) return null;
  const v = tierVars[varIdx];
  const base = v.base ?? 0;
  const perLvl = v.per_lvl ?? 0;
  const hasSuffix = v.suffix === "%%";
  const raw = base + perLvl * 100;
  const val = Number.isInteger(raw) ? raw : Math.round(raw * 100) / 100;
  return hasSuffix ? `${val}%` : `${val}`;
}

function decodeNbtAndGetTextureUrl(nbtString) {
  try {
    const match = nbtString.match(/Value:"([^"]+)"/);
    if (!match || !match[1]) return null;
    const decodedJson = JSON.parse(
      Buffer.from(match[1], "base64").toString("utf8"),
    );
    return decodedJson?.textures?.SKIN?.url || null;
  } catch {
    return null;
  }
}

function stripFormatting(text) {
  return String(text || "").replace(/§[0-9a-fk-or]/gi, "").trim();
}

function parsePetInfo(nbtString) {
  try {
    const match = nbtString.match(/petInfo:"(\{.*?\})"/);
    if (!match || !match[1]) return null;
    const unescaped = match[1].replace(/\\"/g, '"');
    return JSON.parse(unescaped);
  } catch {
    return null;
  }
}

const STAT_KEY_MAP = {
  HEALTH: "hp",
  DEFENSE: "def",
  TRUE_DEFENSE: "td",
  STRENGTH: "str",
  INTELLIGENCE: "int",
  SPEED: "spd",
  SEA_CREATURE_CHANCE: "scc",
  MAGIC_FIND: "mf",
  PET_LUCK: "pet_luck",
  BONUS_ATTACK_SPEED: "spd_attack",
  CRIT_CHANCE: "cc",
  CRIT_DAMAGE: "cd",
  ABILITY_DAMAGE: "dmg",
  MINING_FORTUNE: "mining_fortune",
  FARMING_FORTUNE: "farming_fortune",
  FORAGING_FORTUNE: "foraging_fortune",
  HEAT_RESISTANCE: "heat_resistance",
};

function calcStatAtLvl100(luaPetData, statKey) {
  if (!luaPetData || !luaPetData.stats) return null;
  const entry = luaPetData.stats[statKey];
  if (!entry) return null;
  let perLvl = 0,
    base = 0;
  if (Array.isArray(entry)) {
    perLvl = entry[0] || 0;
    base = entry[1] || 0;
  } else if (typeof entry === "object") {
    perLvl = entry[1] ?? 0;
    base = entry[2] ?? 0;
  } else {
    perLvl = entry;
  }
  const raw = base + perLvl * 100;
  return Number.isInteger(raw) ? `${raw}` : `${Math.round(raw * 100) / 100}`;
}

function cleanLore(loreArray, luaPetData, tierName) {
  if (!loreArray) return "";
  let joined = loreArray.join("\n");
  joined = joined.replace(/\{LVL\}/g, "100");
  joined = joined.replace(/\{([0-9]+)\}/g, (_, idx) => {
    const val = calcVarAtLvl100(luaPetData, tierName, parseInt(idx));
    return val !== null ? val : "?";
  });
  joined = joined.replace(/\{([A-Z_]+)\}/g, (_, varName) => {
    if (varName === "LVL") return "100";
    const luaStatKey = STAT_KEY_MAP[varName];
    if (luaStatKey) {
      const val = calcStatAtLvl100(luaPetData, luaStatKey);
      if (val !== null) return val;
    }
    const formatted = varName
      .split("_")
      .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
      .join(" ");
    return `[${formatted}]`;
  });
  joined = joined.replace(/%%/g, "%");
  return joined;
}

function extractHexColor(loreArray) {
  for (const line of loreArray || []) {
    const match = line.match(/#([0-9a-f]{6})/i);
    if (match) return `#${match[1].toUpperCase()}`;
  }
  return null;
}

function getHelmetCategory(name) {
  if (name.includes("Power Orb")) return "Power Orb";
  if (name.includes("Backpack Skin")) return "Backpack";
  if (name.includes("Greenhouse Skin")) return "Greenhouse";
  if (name.includes("Barn Skin")) return "Barn";
  return "Helmet";
}

async function generateVariantManifest(
  sourceDir,
  outputFile,
  publicDir,
  assetBasePath,
  options = {},
) {
  if (!fs.existsSync(sourceDir)) {
    console.warn("Variant source directory not found at", sourceDir);
    return;
  }

  const excludeIds = options.excludeIds || new Set();
  const getCategory = options.getCategory;
  const variants = [];
  const files = fs
    .readdirSync(sourceDir)
    .filter((file) => file.endsWith(".json"))
    .sort();

  for (const file of files) {
    const content = JSON.parse(fs.readFileSync(path.join(sourceDir, file), "utf8"));
    const textureUrl = decodeNbtAndGetTextureUrl(content.nbttag);
    if (!textureUrl) continue;

    let localPath = textureUrl;
    const hash = getTextureHash(textureUrl);
    if (hash) {
      const relativePath = `${assetBasePath}/${hash}.png`;
      const downloaded = await ensureTextureDownloaded(
        textureUrl,
        publicDir,
        hash,
        relativePath,
      );
      if (downloaded) localPath = downloaded;
    }

    const internalId = content.internalname || file.replace(".json", "");
    if (excludeIds.has(internalId)) continue;

    const name = stripFormatting(content.displayname || content.name || internalId);
    const variant = {
      id: internalId,
      name,
      texturePath: localPath,
      lore: cleanLore(content.lore, null, null),
      animated: false,
    };

    if (getCategory) {
      variant.category = getCategory(name, content);
    }

    variants.push(variant);
  }

  fs.writeFileSync(outputFile, JSON.stringify({ variants }, null, 2));
}

async function generateDyeIndex() {
  await generateVariantManifest(
    DYES_DIR,
    OUTPUT_DYE_REGISTRY,
    PUBLIC_DYES,
    "/assets/dyes/skins",
  );
  const dyeCount = fs.existsSync(OUTPUT_DYE_REGISTRY)
    ? JSON.parse(fs.readFileSync(OUTPUT_DYE_REGISTRY, "utf8")).variants.length
    : 0;
  console.log(`Successfully indexed ${dyeCount} dye items.`);
}

async function generateHelmetIndex(petVariantIds) {
  await generateVariantManifest(
    SKULL_COSMETICS_DIR,
    OUTPUT_HELMET_REGISTRY,
    PUBLIC_HELMETS,
    "/assets/helmets/skins",
    {
      excludeIds: petVariantIds,
      getCategory: getHelmetCategory,
    },
  );
  const helmetCount = fs.existsSync(OUTPUT_HELMET_REGISTRY)
    ? JSON.parse(fs.readFileSync(OUTPUT_HELMET_REGISTRY, "utf8")).variants.length
    : 0;
  console.log(`Successfully indexed ${helmetCount} helmet items.`);
}

async function generateIndex() {
  if (!fs.existsSync(PETS_DIR)) {
    console.error("Pets directory not found at", PETS_DIR);
    return;
  }

  for (const dir of [
    OUTPUT_DATA_DIR,
    PUBLIC_DEFAULTS,
    PUBLIC_SKINS,
    PUBLIC_DYES,
    PUBLIC_HELMETS,
    PUBLIC_ANIMATED,
  ]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  for (const file of [OUTPUT_DYE_REGISTRY, OUTPUT_HELMET_REGISTRY]) {
    fs.rmSync(file, { force: true });
  }

  fs.mkdirSync(OUTPUT_DATA_DIR, { recursive: true });

  const luaData = getLuaData();
  const animatedSkullsRaw = fs.existsSync(ANIMATED_SKULLS_FILE)
    ? JSON.parse(fs.readFileSync(ANIMATED_SKULLS_FILE, "utf8"))
    : {};

  const customAnimatedSkullsRaw = fs.existsSync(CUSTOM_ANIMATED_FILE)
    ? JSON.parse(fs.readFileSync(CUSTOM_ANIMATED_FILE, "utf8"))
    : {};

  const animatedSkins = {
    ...(animatedSkullsRaw.skins || animatedSkullsRaw),
    ...(customAnimatedSkullsRaw.skins || customAnimatedSkullsRaw),
  };

  const petVariantIds = new Set();
  const registry = {};
  const petFolders = fs
    .readdirSync(PETS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "animated_skins")
    .map((d) => d.name);

  for (const petId of petFolders) {
    const defaultDir = path.join(PETS_DIR, petId, "defaults");
    const skinsDir = path.join(PETS_DIR, petId, "skins");

    if (!fs.existsSync(defaultDir)) continue;

    const defaultFiles = fs
      .readdirSync(defaultDir)
      .filter((f) => f.endsWith(".json"));
    if (defaultFiles.length === 0) continue;
    defaultFiles.sort();

    const highestRarityFile = defaultFiles[defaultFiles.length - 1];
    const baseContent = JSON.parse(
      fs.readFileSync(path.join(defaultDir, highestRarityFile), "utf8"),
    );

    const petInfo = baseContent.nbttag
      ? parsePetInfo(baseContent.nbttag)
      : null;
    const cleanType = petInfo?.type || petId;
    const rawName = baseContent.displayname || baseContent.name || petId;
    const cleanName = rawName.replace(/§[0-9a-fk-or]\[.*?\]\s*/gi, "");

    let category = "Pet";
    const firstLoreLine = baseContent.lore?.[0] ?? "";
    if (firstLoreLine.includes("Mining")) category = "Mining";
    else if (firstLoreLine.includes("Fishing")) category = "Fishing";
    else if (firstLoreLine.includes("Combat")) category = "Combat";
    else if (firstLoreLine.includes("Farming")) category = "Farming";
    else if (firstLoreLine.includes("Foraging")) category = "Foraging";
    else if (firstLoreLine.includes("Alchemy")) category = "Alchemy";
    else if (firstLoreLine.includes("Enchanting")) category = "Enchanting";
    else if (firstLoreLine.includes("All Skills")) category = "All";

    const luaPet = luaData[cleanType] || luaData[petId] || null;
    const tierMap = [
      "Common",
      "Uncommon",
      "Rare",
      "Epic",
      "Legendary",
      "Mythic",
      "Divine",
    ];

    const petData = {
      name: cleanName,
      type: cleanType,
      category,
      description: cleanLore(baseContent.lore, luaPet, "Legendary"),
      infoUrls: baseContent.info || [],
      recipes: baseContent.recipes || [],
      rarities: [],
      variants: [],
    };

    const registryEntry = {
      name: cleanName,
      category,
      rarities: [],
      variantsCount: 0,
    };

    for (const file of defaultFiles) {
      const content = JSON.parse(
        fs.readFileSync(path.join(defaultDir, file), "utf8"),
      );
      const textureUrl =
        decodeNbtAndGetTextureUrl(content.nbttag) || "/assets/skins/steve.png";

      let localPath = textureUrl;
      const hash = getTextureHash(textureUrl);
      if (hash) {
        const destDir = path.join(PUBLIC_DEFAULTS, petId);
        const relativePath = `/assets/pets/defaults/${petId}/${hash}.png`;
        const downloaded = await ensureTextureDownloaded(
          textureUrl,
          destDir,
          hash,
          relativePath,
        );
        if (downloaded) localPath = downloaded;
      }

      const internalName = content.internalname || file.replace(".json", "");
      const raritySuffix = internalName.match(/;(\d)/);
      const tierIdx = raritySuffix ? parseInt(raritySuffix[1]) : 4;
      const tierName = tierMap[tierIdx] || "Default";

      petData.rarities.push({
        id: internalName,
        name: tierName,
        texturePath: localPath,
        lore: cleanLore(content.lore, luaPet, tierName),
      });

      registryEntry.rarities.push({ name: tierName });
    }

    if (fs.existsSync(skinsDir)) {
      const skinFiles = fs
        .readdirSync(skinsDir)
        .filter((f) => f.endsWith(".json"));

      for (const file of skinFiles) {
        const content = JSON.parse(
          fs.readFileSync(path.join(skinsDir, file), "utf8"),
        );
        const rawSkinName = content.displayname || file;
        const internalId = content.internalname || file.replace(".json", "");
        petVariantIds.add(internalId);
        const cleanedLoreForSkin = cleanLore(content.lore, null, null);

        const findAnimKey = (target) => {
          if (animatedSkins[target]) return target;
          const noPrefix = target.replace(/^PET_SKIN_/, "");
          if (animatedSkins[noPrefix]) return noPrefix;
          const pathKey = Object.keys(animatedSkins).find((k) =>
            k.includes(target),
          );
          if (pathKey) return pathKey;
          return null;
        };

        const resolvedDayKey = findAnimKey(`${internalId}_DAY`);
        const resolvedNightKey = findAnimKey(`${internalId}_NIGHT`);
        const resolvedStandardKey = findAnimKey(internalId);

        let animationData = undefined;
        let localPath = "/assets/skins/steve.png";
        let isAnimated = false;

        const processFrames = async (def, animKeyStr) => {
          const cleanFolder = animKeyStr.split("/").pop().replace(".json", "");
          const outDir = path.join(PUBLIC_ANIMATED, petId, cleanFolder);
          const frames = [];
          for (let t of def.textures) {
            const b64 = t.split(":")[1];
            if (!b64) continue;
            try {
              const decoded = JSON.parse(
                Buffer.from(b64, "base64").toString("utf8"),
              );
              const frameUrl = decoded.textures?.SKIN?.url;
              const frameHash = getTextureHash(frameUrl);
              const relativePath = `/assets/pets/skins/animated_skins/${petId}/${cleanFolder}/${frameHash}.png`;
              if (frameUrl && frameHash) {
                await ensureTextureDownloaded(
                  frameUrl,
                  outDir,
                  frameHash,
                  relativePath,
                );
                frames.push(relativePath);
              }
            } catch (e) {}
          }
          return { ticks: def.ticks || 3, frames };
        };

        if (resolvedDayKey && resolvedNightKey) {
          isAnimated = true;
          animationData = {
            day: await processFrames(
              animatedSkins[resolvedDayKey],
              resolvedDayKey,
            ),
            night: await processFrames(
              animatedSkins[resolvedNightKey],
              resolvedNightKey,
            ),
          };

          if (animationData.day.frames.length > 0) {
            localPath = animationData.day.frames[0];
          }
        } else if (resolvedStandardKey) {
          isAnimated = true;
          animationData = await processFrames(
            animatedSkins[resolvedStandardKey],
            resolvedStandardKey,
          );

          if (animationData.frames && animationData.frames.length > 0) {
            localPath = animationData.frames[0];
          }
        } else {
          const textureUrl =
            decodeNbtAndGetTextureUrl(content.nbttag) ||
            "/assets/skins/steve.png";
          localPath = textureUrl;
          const hash = getTextureHash(textureUrl);
          if (hash) {
            const destDir = path.join(PUBLIC_SKINS, petId);
            const relativePath = `/assets/pets/skins/${petId}/${hash}.png`;
            const downloaded = await ensureTextureDownloaded(
              textureUrl,
              destDir,
              hash,
              relativePath,
            );
            if (downloaded) localPath = downloaded;
          }
        }

        if (
          !isAnimated &&
          cleanedLoreForSkin &&
          cleanedLoreForSkin.includes("is animated")
        ) {
          isAnimated = true;
        }

        petData.variants.push({
          id: internalId,
          name: rawSkinName.replace(/§[0-9a-fk-or]/g, ""),
          texturePath: localPath,
          lore: cleanedLoreForSkin,
          animated: isAnimated,
          animation: animationData,
        });

        registryEntry.variantsCount++;
      }
    }

    registry[petId] = registryEntry;
    fs.writeFileSync(
      path.join(OUTPUT_DATA_DIR, `${petId}.json`),
      JSON.stringify(petData, null, 2),
    );
  }

  fs.writeFileSync(OUTPUT_REGISTRY, JSON.stringify(registry, null, 2));
  console.log(
    `Successfully generated registry and indexed ${Object.keys(registry).length} pets with local textures.`,
  );

  await generateDyeIndex();
  await generateHelmetIndex(petVariantIds);
}

generateIndex().catch(console.error);
