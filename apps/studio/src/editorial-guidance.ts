import { z } from "zod";

export const PRODUCT_CLASS_PROFILE_VERSION = 1 as const;

const textList = z.array(z.string().trim().min(1));
const safeId = z
  .string()
  .trim()
  .min(1)
  .regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/);

export const productClassProfileSchema = z.strictObject({
  classId: safeId,
  aliases: textList,
  searchVocabulary: textList,
  importantAttributes: textList,
  requiredAttributes: textList,
  undesirableAttributes: textList,
  compatibilityRisks: textList,
  giftabilityConsiderations: textList,
  queryExpansionHints: textList,
  maintenanceConsiderations: textList,
  evaluationGuidance: textList,
  version: z.literal(PRODUCT_CLASS_PROFILE_VERSION),
});

export type ProductClassProfile = z.infer<typeof productClassProfileSchema>;

export const PRODUCT_CLASS_PROFILES: readonly ProductClassProfile[] = z
  .array(productClassProfileSchema)
  .parse([
    {
      classId: "weatherproof-field-notebook",
      aliases: ["weatherproof field notebook", "all-weather notebook", "waterproof notebook"],
      searchVocabulary: ["weatherproof notebook", "all-weather field notes", "top spiral notebook"],
      importantAttributes: ["usable writing format", "portable size", "durable binding"],
      requiredAttributes: ["paper or writing surface intended for wet conditions"],
      undesirableAttributes: ["decorative notebook without weather protection"],
      compatibilityRisks: ["writing-tool compatibility", "size and pocket fit"],
      giftabilityConsiderations: ["more giftable as a complete writing set"],
      queryExpansionHints: ["field notes", "wet conditions", "top spiral"],
      maintenanceConsiderations: ["recheck the exact page format and dimensions"],
      evaluationGuidance: ["favor credible field utility over firefighter-themed decoration"],
      version: 1,
    },
    {
      classId: "hydration-reservoir",
      aliases: ["hydration reservoir", "water bladder", "hydration bladder"],
      searchVocabulary: ["large-capacity hydration reservoir", "pack hydration bladder"],
      importantAttributes: ["capacity", "pack compatibility", "fill and cleaning access"],
      requiredAttributes: [],
      undesirableAttributes: ["station-only drinkware presented as fireline hydration"],
      compatibilityRisks: ["pack dimensions", "hose and connector system", "cleaning routine"],
      giftabilityConsiderations: ["utility is strong when the recipient's pack system is known"],
      queryExpansionHints: ["large capacity", "remote field", "replacement reservoir"],
      maintenanceConsiderations: ["models and connector systems change"],
      evaluationGuidance: ["treat unknown pack compatibility as material selection risk"],
      version: 1,
    },
    {
      classId: "compression-socks",
      aliases: ["compression socks", "compression hosiery"],
      searchVocabulary: ["everyday compression socks", "work compression socks"],
      importantAttributes: ["size range", "compression level", "fabric and care"],
      requiredAttributes: [],
      undesirableAttributes: ["unsupported health or performance claims"],
      compatibilityRisks: ["size", "compression preference", "medical suitability"],
      giftabilityConsiderations: ["easy presentation but difficult personal fit"],
      queryExpansionHints: ["size chart", "everyday wear", "care instructions"],
      maintenanceConsiderations: ["recheck sizing and exact compression specifications"],
      evaluationGuidance: ["penalize guessing fit or making medical claims"],
      version: 1,
    },
    {
      classId: "insulated-drinkware",
      aliases: ["insulated tumbler", "insulated drinkware", "travel tumbler"],
      searchVocabulary: ["leak-resistant insulated tumbler", "lidded travel drinkware"],
      importantAttributes: ["capacity", "lid design", "cleaning", "cup-holder fit"],
      requiredAttributes: [],
      undesirableAttributes: ["generic profession slogan as the main value"],
      compatibilityRisks: ["lid preference", "dishwasher care", "cup-holder dimensions"],
      giftabilityConsiderations: ["familiar gift format with room for thoughtful presentation"],
      queryExpansionHints: ["leak resistant", "easy clean", "shift drinkware"],
      maintenanceConsiderations: ["colors, lids, and model variants rotate"],
      evaluationGuidance: ["require a specific routine fit, not profession-only relevance"],
      version: 1,
    },
    {
      classId: "protective-equipment-case",
      aliases: ["stethoscope case", "protective equipment case", "hard-shell tool case"],
      searchVocabulary: ["protective stethoscope case", "portable equipment case"],
      importantAttributes: ["interior dimensions", "closure", "cleanability"],
      requiredAttributes: [],
      undesirableAttributes: ["case selected without knowing the carried item"],
      compatibilityRisks: ["equipment dimensions", "workplace storage rules"],
      giftabilityConsiderations: ["useful and presentable when the exact equipment is known"],
      queryExpansionHints: ["hard shell", "interior dimensions", "zippered organizer"],
      maintenanceConsiderations: ["verify dimensions against current equipment variants"],
      evaluationGuidance: ["make compatibility uncertainty visible rather than inferring fit"],
      version: 1,
    },
    {
      classId: "generic",
      aliases: [],
      searchVocabulary: [],
      importantAttributes: ["specific use case", "selection criteria", "consumer value"],
      requiredAttributes: [],
      undesirableAttributes: ["generic profession branding without contextual value"],
      compatibilityRisks: ["unknown recipient, use, size, or system compatibility"],
      giftabilityConsiderations: ["presentation, ease of choosing, and recipient relevance"],
      queryExpansionHints: [],
      maintenanceConsiderations: ["recheck volatile commercial details"],
      evaluationGuidance: ["state missing class-specific guidance instead of inventing it"],
      version: 1,
    },
  ]);

function normalized(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function resolveProductClassProfile(
  productClass: string,
  profiles: readonly ProductClassProfile[] = PRODUCT_CLASS_PROFILES,
): ProductClassProfile {
  const query = normalized(productClass);
  const generic = profiles.find(({ classId }) => classId === "generic");
  if (!generic) throw new TypeError('ProductClassProfiles must include the "generic" fallback.');
  if (!query) return generic;
  return (
    profiles
      .filter(({ classId }) => classId !== "generic")
      .flatMap((profile) =>
        [profile.classId, ...profile.aliases, ...profile.searchVocabulary].map((alias) => ({
          profile,
          alias: normalized(alias),
        })),
      )
      .filter(
        ({ alias }) => alias && (query === alias || query.includes(alias) || alias.includes(query)),
      )
      .sort((left, right) => right.alias.length - left.alias.length)[0]?.profile ?? generic
  );
}
