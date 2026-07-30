import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Service taxonomy from Phase 1 section 7 — the fixed vocabulary every
// job/asset/schedule hangs off of, so this seed is a prerequisite for
// almost every other piece of demo data.
const CATALOG: Record<string, { name: string; requiresInspection?: boolean; slaHours: number }[]> = {
  Mechanical: [
    { name: "HVAC", slaHours: 24 },
    { name: "Air Conditioning", slaHours: 24 },
    { name: "Pumps", slaHours: 24 },
    { name: "Chillers", requiresInspection: true, slaHours: 48 },
    { name: "Compressors", requiresInspection: true, slaHours: 48 },
  ],
  Electrical: [
    { name: "Generator Maintenance", slaHours: 24 },
    { name: "Solar Systems", requiresInspection: true, slaHours: 48 },
    { name: "Electrical Faults", slaHours: 12 },
    { name: "Wiring", requiresInspection: true, slaHours: 48 },
    { name: "Lighting", slaHours: 24 },
  ],
  Civil: [
    { name: "Plumbing", slaHours: 24 },
    { name: "Masonry", requiresInspection: true, slaHours: 72 },
    { name: "Painting", requiresInspection: true, slaHours: 72 },
    { name: "Roofing", requiresInspection: true, slaHours: 72 },
    { name: "Waterproofing", requiresInspection: true, slaHours: 72 },
  ],
  "Fire Safety": [
    { name: "Fire Alarm Systems", slaHours: 12 },
    { name: "Fire Extinguishers", slaHours: 24 },
    { name: "Sprinklers", slaHours: 24 },
  ],
  Security: [
    { name: "CCTV", slaHours: 24 },
    { name: "Access Control", slaHours: 24 },
    { name: "Electric Fence", slaHours: 24 },
  ],
  Cleaning: [
    { name: "Deep Cleaning", slaHours: 48 },
    { name: "Janitorial", slaHours: 24 },
    { name: "Pest Control", slaHours: 48 },
  ],
  Landscaping: [{ name: "Landscaping", slaHours: 72 }],
  Elevators: [{ name: "Elevators", requiresInspection: true, slaHours: 24 }],
  "General Repairs": [{ name: "General Repairs", slaHours: 24 }],
};

async function main() {
  for (const [categoryName, subcategories] of Object.entries(CATALOG)) {
    const category = await prisma.serviceCategory.upsert({
      where: { name: categoryName },
      update: {},
      create: { name: categoryName },
    });

    for (const sub of subcategories) {
      await prisma.serviceSubcategory.upsert({
        where: { categoryId_name: { categoryId: category.id, name: sub.name } },
        update: {},
        create: {
          categoryId: category.id,
          name: sub.name,
          requiresInspection: sub.requiresInspection ?? false,
          defaultSlaHours: sub.slaHours,
        },
      });
    }
  }

  console.log("Seeded service catalog:", Object.keys(CATALOG).length, "categories");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
