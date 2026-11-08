CREATE TABLE IF NOT EXISTS uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pdf_key TEXT NOT NULL,
  filename TEXT,
  status TEXT,
  vehicle_count INTEGER,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  upload_id INTEGER,
  pdf_key TEXT,
  page_no INTEGER,
  control_no TEXT,
  sheet_format TEXT,
  auction_house TEXT,
  auction_date TEXT,
  auction_round TEXT,
  lot_no TEXT,
  maker TEXT,
  car_name TEXT,
  grade TEXT,
  model_code TEXT,
  year INTEGER,
  first_reg_month INTEGER,
  displacement_cc INTEGER,
  fuel TEXT,
  shift TEXT,
  mileage_km INTEGER,
  inspection TEXT,
  color TEXT,
  color_code TEXT,
  score TEXT,
  score_exterior TEXT,
  score_interior TEXT,
  equipment TEXT,
  start_price_man REAL,
  bid_price_man REAL,
  planned_price_man REAL,
  result TEXT,
  handwritten_note TEXT,
  inspector_note TEXT,
  needs_review INTEGER DEFAULT 0,
  review_reason TEXT,
  buyer TEXT,
  member_name TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_vehicles_car ON vehicles(car_name);
CREATE INDEX IF NOT EXISTS idx_vehicles_date ON vehicles(auction_date);
CREATE INDEX IF NOT EXISTS idx_vehicles_buyer ON vehicles(buyer);
