# iSputnik Home Database Redesign Proposal

## Status

**Proposal**

This document describes a proposed database redesign for iSputnik Home.

The goal is to establish a flexible architecture that supports multiple media types while maintaining a consistent user experience across libraries.

Current development focus remains:

* Audiobooks
* eBooks

Gallery and Document support are included only as architectural placeholders and are not currently planned for implementation.

---

# Important Assumptions

## No Database Migration Required

iSputnik Home is currently in active development and does not require backward compatibility with production data.

For this redesign:

* Existing databases may be discarded
* Existing schemas may be recreated from scratch
* No migration scripts are required
* Legacy table compatibility is not required

This significantly simplifies implementation and allows the schema to be designed correctly before additional features are added.

---

# Design Goals

## Shared Functionality

All library types should support:

* Libraries
* Categories
* Tags
* Collections
* Search
* Permissions
* Sharing
* Favorites
* Activity Logs
* Trash

## Media Specific Functionality

Each media type should maintain dedicated tables for metadata and processing.

Examples:

Audiobooks:

* Audio tracks
* Chapters
* Playback progress
* Audio bookmarks

eBooks:

* Reading progress
* EPUB metadata
* Reader bookmarks

Future:

* Gallery metadata
* EXIF information
* Document metadata

---

# Architecture Overview

The proposed design uses:

```text
Library
    └── Library Item
            ├── Shared Metadata
            ├── Categories
            ├── Tags
            ├── Collections
            ├── Permissions
            └── Media Specific Tables
```

The design intentionally separates:

* Common functionality
* Media-specific functionality

This minimizes duplication while preserving flexibility.

---

# Core Tables

## Libraries

Represents a user-created media library.

Examples:

* Audiobooks
* eBooks
* Family Photos
* Documents

```text
libraries
```

Fields:

```text
id
name
description
type
owner_id
storage_root_id
is_public
created_at
updated_at
```

---

## Library Items

Represents a single media item.

Examples:

* One audiobook
* One ebook
* One photo album
* One document

```text
library_items
```

Fields:

```text
id
library_id
type
title
sort_title
path
cover_path
description
status
created_at
updated_at
```

Supported Types:

```text
audiobook
ebook
gallery
document
```

---

# Metadata

## Item Metadata

Shared metadata across all media types.

```text
item_metadata
```

Fields:

```text
item_id
language
publisher
year
rating
description
```

---

# People

## People

Stores authors, narrators, artists, photographers, and other contributors.

```text
people
```

Fields:

```text
id
name
sort_name
bio
image_path
```

---

## Item People

Links contributors to media items.

```text
item_people
```

Fields:

```text
item_id
person_id
role
```

Supported Roles:

```text
author
narrator
editor
artist
photographer
```

---

# Series

## Series

```text
series
```

Fields:

```text
id
name
description
```

---

## Series Items

```text
series_items
```

Fields:

```text
series_id
item_id
position
```

---

# Categories

## Categories

Categories provide structured navigation.

```text
categories
```

Fields:

```text
id
name
slug
media_type
parent_id
sort_order
```

Examples:

Audiobooks:

```text
Science Fiction
Fantasy
History
Biography
```

Gallery:

```text
Vacation
Family
Events
Nature
```

---

## Item Categories

```text
item_categories
```

Fields:

```text
item_id
category_id
is_primary
source
```

Sources:

```text
manual
scan
metadata
ai
```

---

# Tags

Tags provide flexible user-defined labels.

```text
tags
```

Fields:

```text
id
name
slug
```

---

## Taggables

```text
taggables
```

Fields:

```text
tag_id
entity_type
entity_id
```

Supported Entities:

```text
library_item
person
series
collection
```

---

# Collections

## Collections

User-defined groupings of media.

```text
collections
```

Fields:

```text
id
name
description
owner_id
created_at
updated_at
```

Examples:

```text
Road Trip Books
Summer Reading
Best Science Fiction
```

---

## Collection Items

```text
collection_items
```

Fields:

```text
collection_id
item_id
position
```

---

# Permissions

## Users

```text
users
```

---

## Groups

```text
groups
group_members
```

---

## Access Grants

Unified permissions system.

```text
access_grants
```

Fields:

```text
id
subject_type
subject_id
resource_type
resource_id
role
```

Subject Types:

```text
user
group
public
```

Resource Types:

```text
library
item
collection
```

Roles:

```text
owner
manager
editor
viewer
```

---

# Audiobook Tables

## Audiobook Details

```text
audiobook_details
```

Fields:

```text
item_id
isbn
asin
duration
```

---

## Audio Files

```text
audio_files
```

Fields:

```text
id
item_id
track_number
title
path
duration
codec
bitrate
```

---

## Audio Chapters

```text
audio_chapters
```

Fields:

```text
file_id
title
start_time
end_time
```

---

## Playback Progress

```text
playback_progress
```

Fields:

```text
user_id
item_id
file_id
position
completed
updated_at
```

---

## Audio Bookmarks

```text
audio_bookmarks
```

Fields:

```text
user_id
item_id
file_id
position
note
created_at
```

---

# eBook Tables

## Ebook Details

```text
ebook_details
```

Fields:

```text
item_id
isbn
page_count
```

---

## Ebook Files

```text
ebook_files
```

Fields:

```text
id
item_id
path
format
file_size
```

Formats:

```text
epub
pdf
cbz
mobi
```

---

## Reading Progress

```text
reading_progress
```

Fields:

```text
user_id
item_id
location
percentage
updated_at
```

---

## Ebook Bookmarks

```text
ebook_bookmarks
```

Fields:

```text
user_id
item_id
location
note
created_at
```

---

# Future Placeholder Tables

The following tables are architectural placeholders only.

These are included to validate the design but are not currently planned for implementation.

## Gallery

```text
gallery_details
gallery_assets
```

Possible future fields:

```text
taken_at
camera_model
latitude
longitude
```

---

## Documents

```text
document_details
document_files
```

Possible future fields:

```text
page_count
mime_type
author
```

---

# Database Diagram

```text
users
 │
 ├── groups
 │    └── group_members
 │
 └── access_grants
      │
      ▼

libraries
 │
 └── library_items
      │
      ├── item_metadata
      │
      ├── item_people
      │      │
      │      └── people
      │
      ├── item_categories
      │      │
      │      └── categories
      │
      ├── collection_items
      │      │
      │      └── collections
      │
      ├── taggables
      │      │
      │      └── tags
      │
      ├── audiobook_details
      │      │
      │      ├── audio_files
      │      │      │
      │      │      └── audio_chapters
      │      │
      │      ├── playback_progress
      │      └── audio_bookmarks
      │
      ├── ebook_details
      │      │
      │      ├── ebook_files
      │      ├── reading_progress
      │      └── ebook_bookmarks
      │
      ├── gallery_details
      │      └── gallery_assets
      │
      └── document_details
             └── document_files


series
 │
 └── series_items
        │
        └── library_items
```

---

# Recommended Implementation Order

## Phase 1

Core Infrastructure

```text
libraries
library_items
item_metadata
people
item_people
categories
item_categories
```

## Phase 2

Audiobooks

```text
audiobook_details
audio_files
audio_chapters
playback_progress
audio_bookmarks
```

## Phase 3

eBooks

```text
ebook_details
ebook_files
reading_progress
ebook_bookmarks
```

## Phase 4

Permissions

```text
groups
group_members
access_grants
```

## Phase 5

Organization

```text
tags
taggables
collections
collection_items
```

## Phase 6

Future Media Types

```text
gallery_details
gallery_assets

document_details
document_files
```

---

# Recommendation

Proceed with this redesign before expanding beyond Audiobooks and eBooks.

Benefits:

* Cleaner architecture
* Better separation of concerns
* Easier AI-assisted development
* Consistent permissions model
* Consistent category model
* Consistent collection model
* Reduced duplication
* Easier future expansion
* Better long-term maintainability
