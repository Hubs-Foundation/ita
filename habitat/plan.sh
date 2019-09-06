pkg_name=ita
pkg_origin=mozillareality
pkg_maintainer="Mozilla Mixed Reality <mixreality@mozilla.com>"
pkg_version="0.0.1"
pkg_description="A service for doing Hubs configuration management."

pkg_deps=(
  core/coreutils
  core/node/12.9.0
)

pkg_build_deps=(
  core/git
)

do_build() {
  npm ci
}

do_install() {
  for p in node_modules package.json package-lock.json bin src schemas
  do
    cp -R ./$p "$pkg_prefix"
  done
}

do_strip() {
  return 0;
}
