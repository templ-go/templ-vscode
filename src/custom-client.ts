import { FoldingRangeRequest } from "vscode-languageserver-protocol";
import {
  DynamicFeature,
  LanguageClient,
  StaticFeature,
} from "vscode-languageclient/node";

export class CustomLanguageClient extends LanguageClient {
  public registerFeature(feature: StaticFeature | DynamicFeature<any>): void {
    // Templ does not have a folding implementation
    // so we prevent the client from registering it
    // causing vscode to use it's default folding, which is good enough
    if (
      "registrationType" in feature
      && feature.registrationType.method === FoldingRangeRequest.method
    ) {
      return;
    }
    super.registerFeature(feature);
  }
}
