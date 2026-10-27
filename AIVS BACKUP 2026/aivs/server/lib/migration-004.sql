-- Migration 4 (AIVS 1.3.1): hashtags on cases (JSON array of "#tag" strings)
ALTER TABLE cases ADD COLUMN hashtags TEXT;
