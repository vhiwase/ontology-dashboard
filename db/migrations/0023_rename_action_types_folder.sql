-- ============================================================================
--  0023: the "Actions" folder is "Action Types".
--
--  The folder holds action type DEFINITIONS from the ontology. "Actions" is
--  also the name of the page where one is executed, so the two read as the
--  same thing. The navigation now says "Action Types"; this brings the seeded
--  folder into line so the Spaces page and the nav agree.
--
--  The path is renamed along with the name, and any folder beneath it is
--  re-pathed in the same statement. Seeding matches folders BY PATH, so
--  renaming only the name would leave the next seed creating a second,
--  duplicate "Action Types" folder beside this one.
-- ============================================================================

UPDATE platform.folder
   SET name = 'Action Types'
 WHERE name = 'Actions'
   AND path = '/Ontology/Actions';

UPDATE platform.folder
   SET path = '/Ontology/Action Types' || substr(path, length('/Ontology/Actions') + 1)
 WHERE path = '/Ontology/Actions'
    OR path LIKE '/Ontology/Actions/%';
