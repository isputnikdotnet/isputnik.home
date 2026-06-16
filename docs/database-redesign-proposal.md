# iSputnik Home - Database Redesign Proposal

## Overview

This proposal recommends restructuring the database around a shared media item model while keeping dedicated tables for media-specific metadata.

The goal is to support:

* Audiobooks
* eBooks
* Documents
* Photo Galleries
* Future media types

while maintaining a consistent user experience, permissions model, tagging system, and collection system.

This proposal assumes the project is still in early development and existing data can be discarded.

---

# Design Goals

## Shared Features

All media types should support:

* Libraries
* Categories
* Tags
* Collections
* Permissions
* Favorites
* Bookmarks
* Search
* Sharing
* Trash
* Activity Logs

## Media Specific Features

Each media type should maintain dedicated metadata tables.

Examples:

* Audiobooks require tracks and playback progress
* eBooks require reading progress
* Photos require EXIF metadata
* Documents require page counts and document metadata

---

# Core Tables

## Libraries

```text
libraries
```

Represents a user-created library.

Examples:

* Audiobooks
* eBooks
* Family Photos
* Documents

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

```text
library_items
```

Represents a single media item.

Examples:

* One audiobook
* One ebook
* One PDF
* One photo album

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

Types:

```text
audiobook
ebook
gallery
document
```

---

# Metadata

## Item Metadata

Common metadata shared across all media.

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

```text
item_people
```

Fields:

```text
item_id
person_id
role
```

Roles:

```text
author
narrator
editor
photographer
artist
```

---

# Series

```text
series
```

Fields:

```text
id
name
description
```

Relationship:

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
```

Gallery:

```text
Family
Vacation
Events
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

## Tags

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

Supported:

```text
library_item
person
series
collection
```

---

# Collections

## Collections

```text
collections
```

Fields:

```text
id
name
description
owner_id
```

Examples:

```text
Best Sci-Fi
Summer Reading
Road Trip Books
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

## Chapters

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

# Gallery Tables

## Gallery Details

```text
gallery_details
```

Fields:

```text
item_id
taken_at
camera_model
latitude
longitude
```

---

## Gallery Assets

```text
gallery_assets
```

Fields:

```text
id
item_id
path
thumbnail_path
width
height
```

---

# Progress

## Playback Progress

```text
playback_progress
```

Audiobooks only.

---

## Reading Progress

```text
reading_progress
```

eBooks only.

---

## Bookmarks

```text
bookmarks
```

Shared bookmark table.

Fields:

```text
id
user_id
item_id
position
note
created_at
```

---

# Recommendation

Implement this redesign before adding Gallery or Document libraries.

Benefits:

* Cleaner architecture
* Consistent behavior across all libraries
* Easier AI-assisted development
* Easier future expansion
* Reduced duplication
* Better long-term maintainability
