# Keep kotlinx.serialization metadata for @Serializable classes.
-keepattributes *Annotation*, InnerClasses
-keep,includedescriptorclasses class app.airlock.**$$serializer { *; }
-keepclassmembers class app.airlock.** { *** Companion; }
