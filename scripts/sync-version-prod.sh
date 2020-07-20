#!/bin/bash

#. ./scripts/env.sh
#VERSION=`git tag | tail -1`
VERSION=`git tag -l --points-at HEAD`
if [ "$VERSION" == "" ]; then
  echo "No version at HEAD! Tag it first!"
  exit 1
fi
DESTPATH=$RSYNC_PATH/v$VERSION
DEVPATH=/var/www/html/8bitworkshop.com/dev
TMPDIR=./tmp/$VERSION
grep -H "var VERSION" web/redir.html
grep -H "var VERSION" web/projects/projects.js
echo "Upload version $VERSION to production?"
read
echo "Listing submodules..."
SUBMODS=`git submodule | cut -d ' ' -f 3`
echo "Extracting to $TMPDIR..."
rm -fr $TMPDIR
mkdir -p $TMPDIR
git archive $VERSION | tar x -C $TMPDIR
echo "Copying to $DESTPATH..."
rsync --stats --exclude '.*' --exclude 'scripts/*' --exclude=node_modules --copy-dest=$DEVPATH -rilz --chmod=a+rx -e "ssh" $TMPDIR/ $SUBMODS $DESTPATH
rsync --stats -rilvz --chmod=a+rx -e "ssh" --copy-dest=$DEVPATH ./gen config.js $DESTPATH/
echo "Done."
