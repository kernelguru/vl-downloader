/**
 * Mapping of Vimm's Lair systems to RomM platform folder names.
 *
 * `slug` is RomM's current "universal platform slug" (backend/utils/platform_slugs.py).
 * `legacySlugs` are older names RomM still accepts (IGDB slugs used before RomM 4.x/5.x
 * and common alternatives). If one of them already exists in the library, it is reused,
 * so an existing RomM library keeps its layout.
 */
export interface SystemInfo {
    /** RomM platform folder name */
    slug: string;
    /** Human readable name */
    name: string;
    /** Codes Vimm's Lair uses in URLs, e.g. /vault/N64 */
    vimmCodes: string[];
    /** Other names that appear on Vimm pages (headings / titles) */
    aliases?: string[];
    /** Alternative folder names RomM accepts */
    legacySlugs?: string[];
    /** File extensions (inside archives or bare) that clearly identify the system */
    extensions?: string[];
}

export const SYSTEMS: SystemInfo[] = [
    {slug: 'nes', name: 'Nintendo Entertainment System', vimmCodes: ['NES'], aliases: ['NES', 'Nintendo'], extensions: ['nes', 'unf', 'unif']},
    {slug: 'snes', name: 'Super Nintendo', vimmCodes: ['SNES'], aliases: ['Super Nintendo Entertainment System', 'SNES'], extensions: ['sfc', 'smc']},
    {slug: 'n64', name: 'Nintendo 64', vimmCodes: ['N64'], aliases: ['N64'], extensions: ['n64', 'z64', 'v64']},
    {slug: 'ngc', name: 'GameCube', vimmCodes: ['GameCube', 'GC', 'NGC'], aliases: ['Nintendo GameCube'], legacySlugs: ['gc', 'gamecube'], extensions: ['gcm', 'gcz']},
    {slug: 'wii', name: 'Wii', vimmCodes: ['Wii', 'WiiWare'], aliases: ['Nintendo Wii', 'WiiWare'], extensions: ['wbfs', 'wad']},
    {slug: 'wiiu', name: 'Wii U', vimmCodes: ['WiiU'], aliases: ['Nintendo Wii U'], extensions: ['wux', 'wua']},
    {slug: 'gb', name: 'Game Boy', vimmCodes: ['GB'], aliases: ['Nintendo Game Boy'], extensions: ['gb']},
    {slug: 'gbc', name: 'Game Boy Color', vimmCodes: ['GBC'], aliases: ['Nintendo Game Boy Color'], extensions: ['gbc']},
    {slug: 'gba', name: 'Game Boy Advance', vimmCodes: ['GBA'], aliases: ['Nintendo Game Boy Advance'], extensions: ['gba']},
    {slug: 'nds', name: 'Nintendo DS', vimmCodes: ['DS', 'NDS'], extensions: ['nds']},
    {slug: '3ds', name: 'Nintendo 3DS', vimmCodes: ['3DS'], extensions: ['3ds', 'cia', 'cci', 'cxi']},
    {slug: 'virtualboy', name: 'Virtual Boy', vimmCodes: ['VB'], aliases: ['Nintendo Virtual Boy'], extensions: ['vb', 'vboy']},
    {slug: 'sms', name: 'Master System', vimmCodes: ['SMS'], aliases: ['Sega Master System'], extensions: ['sms']},
    {slug: 'genesis', name: 'Genesis', vimmCodes: ['Genesis', 'MD'], aliases: ['Sega Genesis', 'Mega Drive', 'Sega Mega Drive', 'Genesis/Mega Drive'], legacySlugs: ['genesis-slash-megadrive', 'megadrive'], extensions: ['md', 'gen', 'smd']},
    {slug: 'segacd', name: 'Sega CD', vimmCodes: ['SegaCD', 'SCD'], aliases: ['Mega-CD', 'Mega CD']},
    {slug: 'sega32', name: 'Sega 32X', vimmCodes: ['32X'], aliases: ['32X'], legacySlugs: ['sega32x'], extensions: ['32x']},
    {slug: 'saturn', name: 'Saturn', vimmCodes: ['Saturn'], aliases: ['Sega Saturn']},
    {slug: 'dc', name: 'Dreamcast', vimmCodes: ['Dreamcast', 'DC'], aliases: ['Sega Dreamcast'], extensions: ['gdi', 'cdi']},
    {slug: 'gamegear', name: 'Game Gear', vimmCodes: ['GG'], aliases: ['Sega Game Gear'], extensions: ['gg']},
    {slug: 'psx', name: 'PlayStation', vimmCodes: ['PS1', 'PSX'], aliases: ['Sony PlayStation', 'PS1'], legacySlugs: ['ps', 'ps1']},
    {slug: 'ps2', name: 'PlayStation 2', vimmCodes: ['PS2'], aliases: ['Sony PlayStation 2', 'PS2']},
    {slug: 'ps3', name: 'PlayStation 3', vimmCodes: ['PS3'], aliases: ['Sony PlayStation 3', 'PS3']},
    {slug: 'psp', name: 'PlayStation Portable', vimmCodes: ['PSP'], aliases: ['PSP', 'Sony PSP'], extensions: ['cso']},
    {slug: 'xbox', name: 'Xbox', vimmCodes: ['Xbox'], aliases: ['Microsoft Xbox']},
    {slug: 'xbox360', name: 'Xbox 360', vimmCodes: ['Xbox360', 'X360'], aliases: ['Microsoft Xbox 360']},
    {slug: 'atari2600', name: 'Atari 2600', vimmCodes: ['Atari2600'], extensions: ['a26']},
    {slug: 'atari5200', name: 'Atari 5200', vimmCodes: ['Atari5200'], extensions: ['a52']},
    {slug: 'atari7800', name: 'Atari 7800', vimmCodes: ['Atari7800'], extensions: ['a78']},
    {slug: 'jaguar', name: 'Jaguar', vimmCodes: ['Jaguar'], aliases: ['Atari Jaguar'], extensions: ['j64', 'jag']},
    {slug: 'atari-jaguar-cd', name: 'Jaguar CD', vimmCodes: ['JaguarCD'], aliases: ['Atari Jaguar CD']},
    {slug: 'lynx', name: 'Lynx', vimmCodes: ['Lynx'], aliases: ['Atari Lynx'], extensions: ['lnx']},
    {slug: 'tg16', name: 'TurboGrafx-16', vimmCodes: ['TG16'], aliases: ['TurboGrafx 16', 'PC Engine'], legacySlugs: ['turbografx16--1', 'pcengine'], extensions: ['pce']},
    {slug: 'turbografx-cd', name: 'TurboGrafx-CD', vimmCodes: ['TGCD'], aliases: ['TurboGrafx CD', 'PC Engine CD'], legacySlugs: ['turbografx-16-slash-pc-engine-cd', 'pcenginecd']},
    {slug: 'philips-cd-i', name: 'CD-i', vimmCodes: ['CDi'], aliases: ['Philips CD-i']},
    {slug: 'neo-geo-pocket-color', name: 'Neo Geo Pocket Color', vimmCodes: ['NGPC'], extensions: ['ngc', 'ngpc']},
    {slug: 'wonderswan', name: 'WonderSwan', vimmCodes: ['WS'], extensions: ['ws']},
    {slug: 'wonderswan-color', name: 'WonderSwan Color', vimmCodes: ['WSC'], extensions: ['wsc']},
];

const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

export function findSystemBySlug(slug?: string | null): SystemInfo | undefined {
    if (!slug) {
        return undefined;
    }
    const n = norm(slug);
    return SYSTEMS.find(s => norm(s.slug) === n || (s.legacySlugs ?? []).some(l => norm(l) === n));
}

export function findSystemByVimmCode(code?: string | null): SystemInfo | undefined {
    if (!code) {
        return undefined;
    }
    const n = norm(code);
    return SYSTEMS.find(s => s.vimmCodes.some(c => norm(c) === n));
}

/** Exact (normalized) match against names, aliases and Vimm codes. */
export function findSystemByName(text?: string | null): SystemInfo | undefined {
    if (!text) {
        return undefined;
    }
    const n = norm(text);
    if (!n) {
        return undefined;
    }
    return SYSTEMS.find(s => [s.name, ...(s.aliases ?? []), ...s.vimmCodes].some(a => norm(a) === n));
}

/** Matches "Some Game (Nintendo 64)" or "… - Nintendo 64" style titles, longest name wins. */
export function findSystemInTitle(title?: string | null): SystemInfo | undefined {
    if (!title) {
        return undefined;
    }
    const parts = [
        ...Array.from(title.matchAll(/\(([^)]+)\)|\[([^\]]+)]/g)).map(m => m[1] ?? m[2]),
        ...title.split(/\s[-–|:»]\s/),
    ];
    for (const part of parts) {
        const system = findSystemByName(part.trim());
        if (system) {
            return system;
        }
    }
    return undefined;
}

export function findSystemByExtension(fileName?: string | null): SystemInfo | undefined {
    const ext = fileName?.split('.').pop()?.toLowerCase();
    if (!ext || ext === fileName?.toLowerCase()) {
        return undefined;
    }
    return SYSTEMS.find(s => (s.extensions ?? []).includes(ext));
}
