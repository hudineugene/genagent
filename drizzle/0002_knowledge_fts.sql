-- Полнотекстовый индекс фрагментов базы знаний (FTS5, BM25). Заполняется из кода вместе с kb_chunks.
CREATE VIRTUAL TABLE `kb_chunks_fts` USING fts5(
  `text`,
  `chunk_id` UNINDEXED,
  `source_id` UNINDEXED,
  `client_id` UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);
