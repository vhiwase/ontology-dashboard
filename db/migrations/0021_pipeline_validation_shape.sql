-- ============================================================================
--  0021: a stored pipeline always carries a validation report with the shape
--  the reader expects.
--
--  0015 and 0020 seeded pipelines with validation = '{}'. The builder reads
--  report.errors and report.warnings as arrays, so an empty object made
--  "errors is not iterable" throw inside a useMemo - which unmounts the whole
--  route. The Pipeline Builder rendered as a blank page with no message.
--
--  The UI has been made defensive, which is the real fix: a record it cannot
--  fully understand must degrade to "not validated", never blank the page.
--  This repairs the stored rows as well, because leaving known-malformed data
--  behind and relying on the reader to cope is how the next reader breaks.
-- ============================================================================

UPDATE platform.pipeline
   SET validation = jsonb_build_object(
         'status',   'unvalidated',
         'errors',   '[]'::jsonb,
         'warnings', '[]'::jsonb
       )
 WHERE validation IS NULL
    OR NOT (validation ? 'errors')
    OR NOT (validation ? 'warnings');

-- platform.pipeline_version stores only the graph, not a validation report, so
-- there is nothing to repair there.
