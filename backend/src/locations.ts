export interface Location {
  id: string;
  name: string;
  category: "Social" | "Civic" | "Work" | "Rest" | "Food" | "Water";
  x: number;
  y: number;
  w: number;
  h: number;
  spot: [number, number];
  blurb: string;
}

// 26 locations per 02:30-56, coordinates tile x,y,w,h + spot
export const LOCATIONS: Location[] = [
  { id: "square", name: "The Square", category: "Social", x: 96, y: 55, w: 18, h: 15, spot: [104, 62], blurb: "The main gathering spot for the whole town." },
  { id: "hall", name: "The Town Hall", category: "Civic", x: 98, y: 42, w: 9, h: 6, spot: [104, 50], blurb: "Voting, public debate, and the town's only clock." },
  { id: "market", name: "The Market", category: "Work", x: 84, y: 62, w: 8, h: 5, spot: [90, 66], blurb: "Wool stalls, sacks of oat grain, and goods fallen off carts." },
  { id: "tavern", name: "The Wet Fleece", category: "Social", x: 116, y: 60, w: 7, h: 5, spot: [120, 66], blurb: "The drinking den. Opens when the grain mill stops." },
  { id: "press", name: "The Daily Spit", category: "Work", x: 118, y: 44, w: 7, h: 5, spot: [122, 50], blurb: "The town newspaper press. Prints whatever got shouted in the square." },
  { id: "bank", name: "The Bank", category: "Work", x: 80, y: 44, w: 7, h: 5, spot: [86, 50], blurb: "The ledger of debts and favors between neighbors." },
  { id: "vault", name: "The Vault", category: "Civic", x: 67, y: 45, w: 6, h: 4, spot: [72, 50], blurb: "Storage for the town treasury's coins." },
  { id: "library", name: "The Library", category: "Work", x: 131, y: 46, w: 7, h: 5, spot: [136, 52], blurb: "Holds four books and one extremely serious librarian." },
  { id: "booth", name: "The Fork Booth", category: "Civic", x: 99, y: 71, w: 7, h: 4, spot: [104, 76], blurb: "Reproduction / cloning booth; one llama in, two out." },
  { id: "clinic", name: "The Clinic", category: "Work", x: 130, y: 63, w: 7, h: 4, spot: [134, 68], blurb: "Treats sprains, spit in the eye, and wounded pride." },
  { id: "school", name: "The School", category: "Work", x: 68, y: 63, w: 7, h: 4, spot: [74, 68], blurb: "Teaches the young to tell their grasses apart." },
  { id: "post", name: "The Post Office", category: "Work", x: 143, y: 57, w: 7, h: 4, spot: [148, 62], blurb: "Mail service for residents who never travel." },
  { id: "baths", name: "The Baths", category: "Social", x: 54, y: 57, w: 7, h: 4, spot: [60, 62], blurb: "Hot springs for high-tension conversation." },
  { id: "station", name: "The Station", category: "Civic", x: 162, y: 52, w: 11, h: 5, spot: [170, 58], blurb: "One cart a day, and it is always late." },
  { id: "barn", name: "The Barn", category: "Rest", x: 36, y: 36, w: 11, h: 7, spot: [44, 44], blurb: "Communal sleeping. Nobody admits to snoring." },
  { id: "shed", name: "The Shearing Shed", category: "Work", x: 44, y: 80, w: 9, h: 6, spot: [52, 86], blurb: "The shearing floor; morale drops the moment you walk in." },
  { id: "mill", name: "The Mill", category: "Work", x: 170, y: 78, w: 8, h: 7, spot: [176, 86], blurb: "The mill that grinds oats into more oats." },
  { id: "pens", name: "The Pens", category: "Rest", x: 76, y: 84, w: 18, h: 12, spot: [84, 90], blurb: "Quarantine pens for newcomers before they get adopted." },
  { id: "pond", name: "The Pond", category: "Water", x: 136, y: 86, w: 20, h: 13, spot: [146, 92], blurb: "Drink from the north side. Do not trust the south side." },
  { id: "dock", name: "The Dock", category: "Social", x: 144, y: 96, w: 8, h: 5, spot: [148, 100], blurb: "A wooden dock for the boat that never came back." },
  { id: "meadowW", name: "The West Meadow", category: "Food", x: 16, y: 60, w: 24, h: 20, spot: [30, 70], blurb: "Fresh high-grade pasture; fought over every single day." },
  { id: "meadowE", name: "The East Meadow", category: "Food", x: 172, y: 30, w: 24, h: 18, spot: [186, 40], blurb: "Sour grass; only ever eaten out of spite or grudge." },
  { id: "orchard", name: "The Orchard", category: "Food", x: 28, y: 96, w: 22, h: 16, spot: [40, 104], blurb: "A wild apple orchard everyone claims is communal." },
  { id: "trough", name: "The Trough", category: "Food", x: 94, y: 83, w: 6, h: 3, spot: [96, 84], blurb: "Oat trough at 7 a.m. Come early or go hungry." },
  { id: "fire", name: "The Fire", category: "Social", x: 108, y: 82, w: 5, h: 4, spot: [110, 84], blurb: "A night bonfire lit by nobody knows who." },
  { id: "board", name: "The Notice Board", category: "Civic", x: 103, y: 57, w: 3, h: 2, spot: [104, 58], blurb: "The notice board where townsfolk argue in writing." },
];

export const LOCATION_BY_ID = new Map(LOCATIONS.map((l) => [l.id, l]));
