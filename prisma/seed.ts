import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const DEFAULT_TEAMS: { internalClubName: string; polymarketTeamId: string }[] = [
  { internalClubName: "Arsenal", polymarketTeamId: "Arsenal" },
  { internalClubName: "Manchester City", polymarketTeamId: "Manchester City" },
  { internalClubName: "Liverpool", polymarketTeamId: "Liverpool" },
  { internalClubName: "Chelsea", polymarketTeamId: "Chelsea" },
  { internalClubName: "Manchester United", polymarketTeamId: "Manchester United" },
  { internalClubName: "Tottenham", polymarketTeamId: "Tottenham" },
  { internalClubName: "OKC Thunder", polymarketTeamId: "Thunder" },
  { internalClubName: "San Antonio Spurs", polymarketTeamId: "Spurs" }
];

async function main() {
  const result = await prisma.club_teams_map.createMany({
    data: DEFAULT_TEAMS,
    skipDuplicates: true
  });
  console.log(`club_teams_map: inserted ${result.count} new row(s) (duplicates skipped).`);
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    prisma.$disconnect();
    process.exit(1);
  });
