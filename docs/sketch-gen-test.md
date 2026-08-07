write a (python, perl or deno based) script `generate-test-data` that generates
test data. it should generate ~4000 entries, with a 2500 day streak.  these
entries should be spread across 7 journals, each entry should be about 4-8
paragraphs of text. there should be around 40 tags used and around a 100
locations. also create a script that generates around 3000 images. the images,
tags and locations should be assigned to the entries in natural way.

what I have in mind is that the test data should be written to disk in the
following way

/[year]/[month]/[day]
  /entry1.md
  /entry2.md
  /image1.jpg
  /image2.jpg

so each day has it's own folder with some entries. some days have no entries at
all, or only an image. some entries have no images other days have several
entries and several images, you get the gist.

use frontmatter in the markdown to assign the timestamp, tags and location. use
markdown image links to associate the images

also create a commandline tool `dayzero-cli` in zig that can import the data by
directly talking to the server. it probably best if the commandline tool works
on single items and does not know about the markdown format and on-disk format
of the generated test data. we can use a (perl, python, shell or deno based)
tool to parse the on-disk format and drive the `day0-cli` commandline tool.

