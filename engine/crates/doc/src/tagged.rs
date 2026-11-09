//! The second read an internally tagged enum takes when its tag key is not first (engine-size-3).
//!
//! The stored form writes the tag first (a block's `kind`, an inline object's `type`, a math node's `t`, a content control's
//! `type`), so those enums read it and hand the rest of the map straight to the variant: serde's derive buffers the whole value
//! into its `Content` type instead, which cost code size and open time (engine-size-3). A document from elsewhere may order its
//! keys another way; that case keeps the bytes as JSON, puts the tag first and reads again.

use super::Deserialize;
use serde::de::{self, Deserializer, MapAccess, Visitor};
use std::marker::PhantomData;

/// One struct variant's fields, read from the map after its tag in any order, then built.
macro_rules! variant {
    ($map:expr, $enum:ident :: $variant:ident { $($key:literal : $field:ident $(= $default:expr)?),* $(,)? }) => {{
        $(let mut $field = None;)*
        while let Some(k) = $map.next_key::<String>()? {
            match k.as_str() {
                $($key => {
                    if $field.is_some() {
                        return Err(<M::Error as serde::de::Error>::duplicate_field($key));
                    }
                    $field = Some($map.next_value()?);
                },)*
                _ => {
                    $map.next_value::<serde::de::IgnoredAny>()?;
                }
            }
        }
        $enum::$variant { $($field: variant!(@take $field, $key $(, $default)?)),* }
    }};
    // A unit variant: the tag is all it holds, and the keys around it are read and dropped (serde's derive ignores them).
    ($map:expr, $enum:ident :: $variant:ident) => {{
        while $map.next_key::<serde::de::IgnoredAny>()?.is_some() {
            $map.next_value::<serde::de::IgnoredAny>()?;
        }
        $enum::$variant
    }};
    (@take $v:ident, $key:literal) => {
        match $v {
            Some(v) => v,
            None => serde::de::Deserialize::deserialize(crate::tagged::Missing::<M::Error>::new($key))?,
        }
    };
    (@take $v:ident, $key:literal, $default:expr) => {
        $v.unwrap_or_else(|| $default)
    };
}
pub(crate) use variant;

/// A field no key gave. `Option` fields read as `None`, as serde's derive reads an absent one; every other type is the
/// missing-field error.
pub(crate) struct Missing<E> {
    key: &'static str,
    error: PhantomData<E>,
}

impl<E> Missing<E> {
    pub(crate) fn new(key: &'static str) -> Self {
        Missing { key, error: PhantomData }
    }
}

impl<'de, E: de::Error> Deserializer<'de> for Missing<E> {
    type Error = E;

    fn deserialize_option<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, E> {
        visitor.visit_none()
    }

    fn deserialize_any<V: Visitor<'de>>(self, _: V) -> Result<V::Value, E> {
        Err(E::missing_field(self.key))
    }

    serde::forward_to_deserialize_any! {
        bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string
        bytes byte_buf unit unit_struct newtype_struct seq tuple tuple_struct map struct enum identifier ignored_any
    }
}

/// A tagged enum's entry point: the visitor reads its map. Each tag-first reader calls it, which is how
/// scripts/schema-fields.mjs knows the impl beside a type's derive reads that same form.
pub(crate) fn read<'de, D, V>(d: D, visitor: V) -> Result<V::Value, D::Error>
where
    D: Deserializer<'de>,
    V: Visitor<'de>,
{
    d.deserialize_map(visitor)
}

/// `map`, whose first key `first` is already read, with its `tag` key moved to the front and the enum's reader run on it.
pub(crate) fn reread<'de, M, T>(first: String, mut map: M, tag: &'static str) -> Result<T, M::Error>
where
    M: MapAccess<'de>,
    T: Deserialize<'de>,
{
    let mut entries: Vec<(String, serde_json::Value)> = vec![(first, map.next_value()?)];
    while let Some(k) = map.next_key::<String>()? {
        entries.push((k, map.next_value()?));
    }
    let at = entries.iter().position(|(k, _)| k == tag).ok_or_else(|| de::Error::missing_field(tag))?;
    let tagged = entries.remove(at);
    entries.insert(0, tagged);
    let d = serde::de::value::MapDeserializer::<'_, _, serde_json::Error>::new(entries.into_iter());
    T::deserialize(d).map_err(de::Error::custom)
}
