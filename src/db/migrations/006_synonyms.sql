-- Synonym list (deterministic layer, admin-owned): Gulf term -> canonical Arabic/English for the catalogue search.
-- term_key is the app's normalized match key (src/ai/synonyms.ts synonymKey); the app computes it on every write.
-- Seed rows are marked needs_review: Nabil/the shop should confirm them in /admin/synonyms.
CREATE TABLE synonyms (
  id            bigserial PRIMARY KEY,
  term          text NOT NULL,
  term_key      text NOT NULL UNIQUE,
  canonical_ar  text NOT NULL,
  canonical_en  text NOT NULL DEFAULT '',
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  needs_review  boolean NOT NULL DEFAULT false,
  source        text NOT NULL DEFAULT 'admin' CHECK (source IN ('seed', 'admin', 'suggestion')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Mappings the AI produced that the list does not know. NEVER applied automatically: an admin approves
-- (copied into synonyms) or rejects. Holds the customer's words for a part only (no phone, no message text).
CREATE TABLE synonym_suggestions (
  id            bigserial PRIMARY KEY,
  term          text NOT NULL,
  term_key      text NOT NULL,
  canonical_ar  text NOT NULL,
  canonical_en  text NOT NULL DEFAULT '',
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  seen_count    integer NOT NULL DEFAULT 1,
  first_seen    timestamptz NOT NULL DEFAULT now(),
  last_seen     timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  UNIQUE (term_key, canonical_ar)
);
CREATE INDEX synonym_suggestions_status_idx ON synonym_suggestions (status, last_seen DESC);

INSERT INTO synonyms (term, term_key, canonical_ar, canonical_en, status, needs_review, source) VALUES
  ('قماشات', 'قماشات', 'فحمات فرامل', 'brake pads', 'active', true, 'seed'),
  ('قماش', 'قماش', 'فحمات فرامل', 'brake pads', 'active', true, 'seed'),
  ('قماشة', 'قماشه', 'فحمات فرامل', 'brake pads', 'active', true, 'seed'),
  ('فحمات', 'فحمات', 'فحمات فرامل', 'brake pads', 'active', true, 'seed'),
  ('فحمة', 'فحمه', 'فحمات فرامل', 'brake pads', 'active', true, 'seed'),
  ('تيل', 'تيل', 'فحمات فرامل', 'brake pads', 'active', true, 'seed'),
  ('تيل فرامل', 'تيل فرامل', 'فحمات فرامل', 'brake pads', 'active', true, 'seed'),
  ('فحمات فرامل', 'فحمات فرامل', 'فحمات فرامل', 'brake pads', 'active', true, 'seed'),
  ('هوبات', 'هوبات', 'قرص فرامل', 'brake discs', 'active', true, 'seed'),
  ('ديسك فرامل', 'ديسك فرامل', 'قرص فرامل', 'brake discs', 'active', true, 'seed'),
  ('كفرات', 'كفرات', 'إطارات', 'tyres', 'active', true, 'seed'),
  ('كفر', 'كفر', 'إطارات', 'tyres', 'active', true, 'seed'),
  ('تواير', 'تواير', 'إطارات', 'tyres', 'active', true, 'seed'),
  ('تاير', 'تاير', 'إطارات', 'tyres', 'active', true, 'seed'),
  ('بواجي', 'بواجي', 'بواجي', 'spark plugs', 'active', true, 'seed'),
  ('بوجي', 'بوجي', 'بواجي', 'spark plugs', 'active', true, 'seed'),
  ('بوجيه', 'بوجيه', 'بواجي', 'spark plugs', 'active', true, 'seed'),
  ('بلاكات', 'بلاكات', 'بواجي', 'spark plugs', 'active', true, 'seed'),
  ('شمعات', 'شمعات', 'بواجي', 'spark plugs', 'active', true, 'seed'),
  ('فلتر زيت', 'فلتر زيت', 'فلتر زيت', 'oil filter', 'active', true, 'seed'),
  ('فلتر مكينة', 'فلتر مكينه', 'فلتر زيت', 'oil filter', 'active', true, 'seed'),
  ('فلتر هواء', 'فلتر هواء', 'فلتر هواء', 'air filter', 'active', true, 'seed'),
  ('فلتر هوا', 'فلتر هوا', 'فلتر هواء', 'air filter', 'active', true, 'seed'),
  ('فلتر مكيف', 'فلتر مكيف', 'فلتر مكيف', 'cabin air filter', 'active', true, 'seed'),
  ('فلتر كابينة', 'فلتر كابينه', 'فلتر مكيف', 'cabin air filter', 'active', true, 'seed'),
  ('فلتر بنزين', 'فلتر بنزين', 'فلتر بنزين', 'fuel filter', 'active', true, 'seed'),
  ('رديتر', 'رديتر', 'رديتر', 'radiator', 'active', true, 'seed'),
  ('راديتر', 'راديتر', 'رديتر', 'radiator', 'active', true, 'seed'),
  ('رادياتير', 'رادياتير', 'رديتر', 'radiator', 'active', true, 'seed'),
  ('ردياتير', 'ردياتير', 'رديتر', 'radiator', 'active', true, 'seed'),
  ('دينمو', 'دينمو', 'دينمو', 'alternator', 'active', true, 'seed'),
  ('دينامو', 'دينامو', 'دينمو', 'alternator', 'active', true, 'seed'),
  ('سلف', 'سلف', 'سلف', 'starter motor', 'active', true, 'seed'),
  ('مارش', 'مارش', 'سلف', 'starter motor', 'active', true, 'seed'),
  ('كمبروسر', 'كمبروسر', 'كمبروسر مكيف', 'AC compressor', 'active', true, 'seed'),
  ('كمبرسور', 'كمبرسور', 'كمبروسر مكيف', 'AC compressor', 'active', true, 'seed'),
  ('كمبريسور', 'كمبريسور', 'كمبروسر مكيف', 'AC compressor', 'active', true, 'seed'),
  ('كمبروسر مكيف', 'كمبروسر مكيف', 'كمبروسر مكيف', 'AC compressor', 'active', true, 'seed'),
  ('مساعدات', 'مساعدات', 'مساعدات', 'shock absorbers', 'active', true, 'seed'),
  ('مساعد', 'مساعد', 'مساعدات', 'shock absorbers', 'active', true, 'seed'),
  ('ممتص صدمات', 'ممتص صدمات', 'مساعدات', 'shock absorbers', 'active', true, 'seed'),
  ('طرمبة ماء', 'طرمبه ماء', 'طرمبة ماء', 'water pump', 'active', true, 'seed'),
  ('طرمبة موية', 'طرمبه مويه', 'طرمبة ماء', 'water pump', 'active', true, 'seed'),
  ('طرمبة بنزين', 'طرمبه بنزين', 'طرمبة بنزين', 'fuel pump', 'active', true, 'seed'),
  ('بطارية', 'بطاريه', 'بطارية', 'battery', 'active', true, 'seed'),
  ('مساحات', 'مساحات', 'مساحات', 'wiper blades', 'active', true, 'seed'),
  ('كويلات', 'كويلات', 'كويل', 'ignition coil', 'active', true, 'seed'),
  ('سير مكينة', 'سير مكينه', 'سير', 'drive belt', 'active', true, 'seed'),
  ('قربة', 'قربه', 'قربة ماء', 'coolant reservoir', 'active', true, 'seed');
